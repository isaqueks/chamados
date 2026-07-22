import type { DataSource } from 'typeorm';
import { IsNull } from 'typeorm';
import type Redis from 'ioredis';
import {
  Papel,
  StatusChamado,
  VisibilidadeMensagem,
  type AIProvider,
  type AIProviderResult,
} from '@chamados/shared';
import {
  runInTenantContext,
  criarExecucao,
  marcarExecutando,
  concluirExecucao,
  falharExecucao,
  existeConcluidaParaMensagem,
  gravarEvento,
  transicionarStatus,
  atorSistema,
  UsuarioSchema,
  ChamadoSchema,
  DespachanteNotificacoes,
  type JobTriagem,
} from '@chamados/db';
import { montarInput, type PreparacaoContexto } from './contexto';
import { aplicarResultado, escalarParaHumano, type ResultadoResolucao } from './aplicador';
import { deveTentarResolver, executarResolucao } from './resolucao';
import { ferramentasConfig } from './ferramentas/config';
import type { FetchImpl } from './github-pr';
import { motivoErro } from '../ia/erros';
import {
  adquirirLockComEspera,
  liberarLockTenant,
  manterLockVivo,
  type OpcoesEspera,
} from '../lock-tenant';
import { garantirConhecimento, type MapaLimites } from '../mapeamento/mapeamento';

/**
 * PROCESSADOR da fila `triagem-ia` (M7 — pipeline completo, specs/05 §3). Consome
 * o job e:
 *   1. adquire o LOCK por tenant (1 execução simultânea por tenant);
 *   2. idempotência: descarta se já há `ExecucaoIA` concluída para o par
 *      (chamado, última mensagem) — exceto reprocessamento manual (specs/05 §2);
 *   3. Tx1: transiciona `novo → em_triagem` (defensivo, se ainda `novo` — specs/04
 *      §2), abre `ExecucaoIA` (na_fila → executando) + evento `ia_iniciou`, monta
 *      o contexto e as FERRAMENTAS REAIS read-only (repo/logs/BD);
 *   4. SINCRONIZA a working copy do sistema-alvo (git clone/pull — specs/05 §3.2);
 *   5. chama o provider (FORA da transação — não segura conexão durante I/O);
 *   6. Tx2: APLICA o resultado ao chamado (perguntas/diagnóstico/classificação/
 *      SPEC + transição) e conclui a `ExecucaoIA`. Qualquer falha (git, provider,
 *      aplicação) → `ExecucaoIA.falhou` + `ia_falhou` + escalonamento a humano
 *      (`em_triagem → em_atendimento`), nunca preso sem responsável (specs/05 §8).
 */

export interface DepsProcessador {
  ds: DataSource;
  redis: Redis;
  provider: AIProvider;
  limites: { timeoutMs: number; budgetUsd: number; maxTurnos: number };
  /** Limites do MAPA de conhecimento (D-013). Ausente → triagem sem mapeamento. */
  mapa?: MapaLimites;
  lock: OpcoesEspera;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Config da RESOLUÇÃO automática (specs/05 §6). Opcional (default: rede real). */
  resolucao?: {
    /** Fronteira HTTP do cliente GitHub (injetável em teste/smoke). */
    githubFetch?: FetchImpl;
    /** Timeout do POST de PR (ms). */
    prTimeoutMs?: number;
    /** Base URL do painel para montar o link do chamado no PR (ou null). */
    appBaseUrl?: string | null;
  };
}

export type ResultadoProcessamento =
  | { status: 'concluido'; execucaoId: string }
  | { status: 'falhou'; execucaoId: string; erro: string }
  | { status: 'ignorado'; motivo: 'idempotente' | 'chamado_inexistente' | 'ia_silenciada' };

/** Preparação (Tx1): idempotência, transição, abertura da execução e do contexto. */
type Preparacao =
  | { skip: true; motivo: 'idempotente' | 'chamado_inexistente' | 'ia_silenciada' }
  | { skip: false; execucaoId: string; ctx: PreparacaoContexto; acoes: unknown[] };

export async function processarTriagem(
  job: JobTriagem,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  const { ds, redis, provider, log } = deps;
  const manual = job.gatilho === 'reprocessamento_manual';

  const token = await adquirirLockComEspera(redis, job.tenantId, deps.lock);
  if (!token) {
    // O registrador da fila intercepta este erro e REAGENDA o job sem consumir
    // tentativa (moveToDelayed + DelayedError — D-016). Não fura o limite.
    throw new Error('lock_tenant_indisponivel');
  }
  // Heartbeat (D-016): renova o TTL curto do lock enquanto a execução vive; se
  // o processo morrer (kill/crash), o lock órfão expira em ≤ ttlMs.
  const pararRenovacao = manterLockVivo(redis, job.tenantId, token, {
    ttlMs: deps.lock.ttlMs,
    renovacaoMs: deps.lock.renovacaoMs,
    onPerda: () =>
      log('lock de tenant PERDIDO durante a execução (renovação falhou)', {
        chamadoId: job.chamadoId,
      }),
  });

  let ctx: PreparacaoContexto | null = null;
  try {
    // ---- Tx1: idempotência + transição + abertura da ExecucaoIA + contexto ---
    const acoes: unknown[] = [];
    const prep = await runInTenantContext(ds, job.tenantId, async (em): Promise<Preparacao> => {
      if (!manual && (await existeConcluidaParaMensagem(em, job.chamadoId, job.ultimaMensagemId))) {
        return { skip: true, motivo: 'idempotente' };
      }
      const chamado = await em.findOne(ChamadoSchema, {
        where: { id: job.chamadoId, deleted_at: IsNull() },
      });
      if (!chamado) return { skip: true, motivo: 'chamado_inexistente' };

      // IA silenciada no chamado (D-024): NENHUMA triagem roda — nem a manual
      // (a action já recusa; aqui é a defesa em profundidade contra jobs
      // enfileirados antes do silêncio ou por outros caminhos).
      if (chamado.ia_silenciada) return { skip: true, motivo: 'ia_silenciada' };

      // Transição defensiva novo → em_triagem (specs/04 §2 "quando o worker
      // inicia"): cobre enfileiramentos diretos (sem transição na criação).
      if (chamado.status === StatusChamado.novo) {
        await transicionarStatus(
          em,
          atorSistema(job.tenantId),
          job.chamadoId,
          StatusChamado.em_triagem,
          { motivo: 'triagem_iniciada' },
          undefined,
        );
      }

      const prepCtx = await montarInput(em, job.chamadoId, { acoes, log, limites: deps.limites });
      if (!prepCtx) return { skip: true, motivo: 'chamado_inexistente' };

      const execucaoId = await criarExecucao(
        em,
        { tenant_id: job.tenantId },
        {
          chamado_id: job.chamadoId,
          gatilho: job.gatilho,
          provider: provider.nome,
          modelo: provider.modelo,
          // Espelho FIEL do contexto enviado ao provider (D-014/D-015), para
          // auditoria: título + DESCRIÇÃO (o pedido do cliente) + contagem da
          // timeline COMPLETA (públicas e internas) + solicitante/natureza/
          // prioridade. NÃO duplica o mapa de conhecimento.
          entrada: {
            ultima_mensagem_id: job.ultimaMensagemId,
            gatilho: job.gatilho,
            titulo: prepCtx.input.contexto.titulo,
            descricao: prepCtx.input.contexto.descricao,
            natureza_declarada: prepCtx.input.contexto.naturezaDeclarada,
            prioridade_declarada: prepCtx.input.contexto.prioridadeDeclarada,
            solicitante: prepCtx.input.contexto.solicitante,
            mensagens_timeline: prepCtx.input.contexto.timeline.length,
            mensagens_publicas: prepCtx.input.contexto.timeline.filter(
              (m) => m.visibilidade === VisibilidadeMensagem.publica,
            ).length,
            mensagens_internas: prepCtx.input.contexto.timeline.filter(
              (m) => m.visibilidade === VisibilidadeMensagem.interna,
            ).length,
            // #16: quantas imagens inline foram COLETADAS para o contexto
            // multimodal (o download em si é pós-Tx, best-effort).
            imagens_contexto: prepCtx.refsImagens,
          },
        },
      );
      await marcarExecutando(em, execucaoId);

      const atorIa = await em.findOne(UsuarioSchema, { where: { papel: Papel.agente_ia } });
      await gravarEvento(em, {
        tipo: 'ia_iniciou',
        chamado_id: job.chamadoId,
        ator_id: atorIa?.id ?? null,
        execucao_ia_id: execucaoId,
        dados: { gatilho: job.gatilho, provider: provider.nome, modelo: provider.modelo },
      });

      return { skip: false, execucaoId, ctx: prepCtx, acoes };
    });

    if (prep.skip) {
      log('triagem ignorada', { chamadoId: job.chamadoId, motivo: prep.motivo });
      return { status: 'ignorado', motivo: prep.motivo };
    }
    ctx = prep.ctx;
    const ctxAtivo = prep.ctx;

    // ---- Sincronização + provider (FORA da transação) ----------------------
    let resultado: AIProviderResult | null = null;
    let erro: string | null = null;
    try {
      await ctxAtivo.sincronizar(); // git clone/pull (specs/05 §3.2)
    } catch (err) {
      erro = motivoErro(err);
    }
    // Prepara a working copy DESCARTÁVEL da resolução (specs/05 §6) — no-op se o
    // gate PRÉ-call fechou. Falha aqui NÃO derruba a triagem (best-effort): a
    // resolução simplesmente não acontece.
    if (!erro) {
      try {
        await ctxAtivo.prepararResolucao();
      } catch (err) {
        log('resolucao: preparo da working copy falhou', {
          chamadoId: job.chamadoId,
          erro: motivoErro(err),
        });
      }
    }
    // Conhecimento do sistema (D-013): após o git sync, garante o mapa ATUALIZADO
    // (gera/re-gera como ExecucaoIA separada quando ausente ou o commit mudou) e o
    // injeta no contexto da triagem. Best-effort: `garantirConhecimento` nunca
    // lança (falha de mapa não derruba a triagem).
    if (!erro && deps.mapa && ctxAtivo.sistemaAlvoId) {
      const checkoutDir = ctxAtivo.checkout();
      if (checkoutDir) {
        const conhecimento = await garantirConhecimento({
          ds,
          tenantId: job.tenantId,
          sistemaAlvoId: ctxAtivo.sistemaAlvoId,
          checkoutDir,
          provider,
          limites: deps.mapa,
          log,
        });
        if (conhecimento) ctxAtivo.input.contexto.conhecimento = conhecimento;
      }
    }
    if (!erro) {
      // D-014: agora que o git sync terminou, aponta a exploração NATIVA
      // (Read/Grep/Glob) para o checkout — `cwd` + fronteira do canUseTool.
      if (ctxAtivo.input.exploracao) {
        ctxAtivo.input.exploracao.checkoutDir = ctxAtivo.checkout();
      }
      // #16: baixa as imagens inline (prints) para o contexto MULTIMODAL —
      // best-effort (nunca lança), fora de transação.
      await ctxAtivo.carregarImagens();
      try {
        resultado = await provider.executarTriagem(ctxAtivo.input);
      } catch (err) {
        erro = motivoErro(err);
      }
    }

    // ---- Resolução automática (branch/push/PR — I/O, FORA da transação) -----
    // Gate PÓS-call no PIPELINE (specs/05 §6), nunca no provider. Falha da
    // tentativa NÃO derruba o diagnóstico: vira nota interna de falha + ia_falhou.
    let resolucaoOutcome: ResultadoResolucao = { tipo: 'nenhuma' };
    let resultadoRegistro = resultado;
    if (resultado && !erro) {
      resolucaoOutcome = await tentarResolver(resultado, ctxAtivo, prep.execucaoId, deps, job);
      if (resolucaoOutcome.tipo === 'sucesso') {
        resultadoRegistro = { ...resultado, tentativaResolucao: resolucaoOutcome.tentativa };
      } else if (resolucaoOutcome.tipo === 'falha' && resultado.tentativaResolucao) {
        resultadoRegistro = {
          ...resultado,
          tentativaResolucao: { ...resultado.tentativaResolucao, situacao: 'falhou' },
        };
      } else if (resultado.tentativaResolucao) {
        // Gate não autorizou (ex.: complexidade != facil): o provider propôs algo,
        // mas NENHUM PR/push foi feito → não registra como tentativa (evita
        // sugerir no painel que houve resolução).
        resultadoRegistro = { ...resultado, tentativaResolucao: null };
      }
    }

    // ---- Tx2: aplicação + conclusão (ou falha + escalonamento) --------------
    // Despachante de NOTIFICAÇÕES (M9): captura, DENTRO da Tx2, os jobs traduzidos
    // pelo seam de auditoria a partir das mutações do aplicador (mensagens públicas
    // + transições). O flush (enfileiramento real) é PÓS-COMMIT e best-effort — só
    // ocorre se a Tx2 foi commitada, evitando notificar uma aplicação que sofreu
    // rollback (que aí escalona sem notificar). Notas internas/complexidade/`ia_*`
    // não notificam (o dispatcher filtra).
    let concluido = false;
    const despachanteNotif = new DespachanteNotificacoes(log);
    if (resultado) {
      const r = resultado;
      const rRegistro = resultadoRegistro ?? r;
      // Artefatos entregáveis (D-026) gerados pela IA via `artefato_gerar` —
      // buffers acumulados FORA da transação; o aplicador anexa em Tx2.
      const artefatos = ctxAtivo.artefatos();
      try {
        await runInTenantContext(ds, job.tenantId, async (em) => {
          await aplicarResultado(
            em,
            {
              tenantId: job.tenantId,
              chamadoId: job.chamadoId,
              execucaoId: prep.execucaoId,
              resultado: r,
              resolucao: resolucaoOutcome,
              artefatos,
            },
            { log, despachante: despachanteNotif },
          );
          // Grava o resultado ENRIQUECIDO (tentativa com branch/prUrl/situacao).
          await concluirExecucao(em, prep.execucaoId, rRegistro, prep.acoes);
        });
        concluido = true;
      } catch (err) {
        erro = motivoErro(err); // falha na aplicação → escalona
      }
      if (concluido) await despachanteNotif.flush(); // notificações pós-commit
    }

    if (!concluido) {
      const erroFinal = erro ?? 'erro_desconhecido';
      await runInTenantContext(ds, job.tenantId, async (em) => {
        await falharExecucao(em, prep.execucaoId, erroFinal, { acoes: prep.acoes });
        await escalarParaHumano(
          em,
          {
            tenantId: job.tenantId,
            chamadoId: job.chamadoId,
            execucaoId: prep.execucaoId,
            erro: erroFinal,
          },
          { log },
        );
      });
      log('triagem falhou', {
        chamadoId: job.chamadoId,
        execucaoId: prep.execucaoId,
        erro: erroFinal,
      });
      return { status: 'falhou', execucaoId: prep.execucaoId, erro: erroFinal };
    }

    log('triagem concluída', { chamadoId: job.chamadoId, execucaoId: prep.execucaoId });
    return { status: 'concluido', execucaoId: prep.execucaoId };
  } finally {
    pararRenovacao();
    if (ctx) await ctx.encerrar().catch(() => {});
    await liberarLockTenant(redis, job.tenantId, token).catch(() => {});
  }
}

/**
 * Avalia o gate PÓS-call e, se autorizado, executa a tentativa de resolução
 * (branch/push/PR). Devolve o desfecho para o aplicador registrar em Tx2. Nunca
 * lança: falha da tentativa vira `{ tipo: 'falha' }` (o diagnóstico segue intacto).
 */
async function tentarResolver(
  resultado: AIProviderResult,
  ctx: PreparacaoContexto,
  execucaoId: string,
  deps: DepsProcessador,
  job: JobTriagem,
): Promise<ResultadoResolucao> {
  const { log } = deps;
  const copia = ctx.copiaResolucao();
  const repo = ctx.resolucao.repo;

  const gate = deveTentarResolver({
    tenantHabilitado: ctx.resolucao.tenantHabilitado,
    naturezaEfetiva: resultado.naturezaAjustada ?? ctx.input.contexto.naturezaDeclarada,
    complexidade: resultado.complexidade,
    compreendido: resultado.compreendido,
    confianca: resultado.confianca,
    confiancaMin: ferramentasConfig.resolucao.confiancaMin,
    temTentativa: resultado.tentativaResolucao !== null,
    repoConfigurado: repo !== null,
  });
  if (!gate || !copia || !repo || !resultado.tentativaResolucao) {
    return { tipo: 'nenhuma' };
  }

  const appBaseUrl = deps.resolucao?.appBaseUrl ?? null;
  const chamadoUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, '')}/app/chamados/${job.chamadoId}`
    : null;

  try {
    const tentativa = await executarResolucao(
      {
        dir: copia.dir,
        repoUrl: repo.repoUrl,
        credencial: repo.credencial,
        branchPadrao: repo.branchPadrao,
        chamado: { numero: ctx.resolucao.numeroChamado, titulo: ctx.input.contexto.titulo },
        execucaoId,
        tentativaProvider: resultado.tentativaResolucao,
        diagnostico: resultado.diagnostico,
        chamadoUrl,
      },
      {
        log,
        githubFetch: deps.resolucao?.githubFetch,
        webhookTimeoutMs: deps.resolucao?.prTimeoutMs,
      },
    );
    return { tipo: 'sucesso', tentativa };
  } catch (err) {
    const motivo = motivoErro(err);
    log('resolucao: tentativa falhou', { chamadoId: job.chamadoId, motivo });
    return { tipo: 'falha', motivo };
  }
}
