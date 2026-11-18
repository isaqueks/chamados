import type { DataSource, EntityManager } from 'typeorm';
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
  cancelarExecucao,
  MOTIVO_CANCELAMENTO_IA_SILENCIADA,
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
import {
  aplicarResultado,
  escalarParaHumano,
  encerrarTriagemCancelada,
  type ResultadoResolucao,
} from './aplicador';
import {
  descartarSinalObsoleto,
  observarCancelamento,
  type ObservadorCancelamento,
} from './cancelamento';
import { deveTentarResolver, executarResolucao } from './resolucao';
import { ferramentasConfig } from './ferramentas/config';
import type { FetchImpl } from './github-pr';
import {
  ErroTriagemCancelada,
  motivoErro,
  telemetriaDoErro,
  type TelemetriaParcial,
} from '../ia/erros';
import {
  adquirirLockComEspera,
  liberarLockTenant,
  manterLockVivo,
  type OpcoesEspera,
} from '../lock-tenant';
import { garantirConhecimento, type MapaLimites } from '../mapeamento/mapeamento';
import { modeloEfetivoDe } from '../ia/parametros-tenant';

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
 *
 * CANCELAMENTO por silêncio (D-041): se a IA é silenciada no chamado DURANTE a
 * execução, o sinal Redis (observado por polling) aborta o provider pelo mesmo
 * mecanismo do timeout e os pontos de checagem (pós-git, pós-mapa, antes do
 * push da resolução, antes da Tx2) param o pipeline. Rede de segurança: a Tx2
 * relê `ia_silenciada` com lock da linha — silenciado, NADA é aplicado. Desfecho:
 * `ExecucaoIA.cancelado` (erro `ia_silenciada`, telemetria parcial) + nota
 * interna + `em_triagem → em_atendimento`, sem mensagem ao cliente e sem retry.
 */

export interface DepsProcessador {
  ds: DataSource;
  redis: Redis;
  provider: AIProvider;
  limites: { timeoutMs: number; budgetUsd: number; maxTurnos: number };
  /** Teto do timeout por tenant (D-044). Ausente → `IA_TIMEOUT_TENANT_MAX_MS`. */
  tetoTimeoutTenantMs?: number;
  /** Limites do MAPA de conhecimento (D-013). Ausente → triagem sem mapeamento. */
  mapa?: MapaLimites;
  /** Intervalo do polling do sinal de cancelamento (D-041). Default: 2 s. */
  cancelamentoPollMs?: number;
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
  | { status: 'cancelado'; execucaoId: string; motivo: 'ia_silenciada' }
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

  // D-041: apaga um sinal de cancelamento OBSOLETO antes da Tx1 (que relê a
  // flag) — qualquer sinal gravado daqui em diante é de um silêncio posterior.
  await descartarSinalObsoleto(redis, job.chamadoId);

  let ctx: PreparacaoContexto | null = null;
  let observador: ObservadorCancelamento | null = null;
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

      const prepCtx = await montarInput(em, job.chamadoId, {
        acoes,
        log,
        limites: deps.limites,
        tetoTimeoutTenantMs: deps.tetoTimeoutTenantMs,
      });
      if (!prepCtx) return { skip: true, motivo: 'chamado_inexistente' };
      // D-044: grava o modelo EFETIVO (override do tenant ou default do provider).
      const modelo = modeloEfetivoDe(provider, prepCtx.input.parametrosModelo);

      const execucaoId = await criarExecucao(
        em,
        { tenant_id: job.tenantId },
        {
          chamado_id: job.chamadoId,
          gatilho: job.gatilho,
          provider: provider.nome,
          modelo,
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
            // D-044: parâmetros efetivos desta execução (override do tenant;
            // `null` = default do provider) e o timeout aplicado.
            parametros_modelo: prepCtx.input.parametrosModelo ?? null,
            timeout_ms: prepCtx.input.limites.timeoutMs,
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
        dados: { gatilho: job.gatilho, provider: provider.nome, modelo },
      });

      return { skip: false, execucaoId, ctx: prepCtx, acoes };
    });

    if (prep.skip) {
      log('triagem ignorada', { chamadoId: job.chamadoId, motivo: prep.motivo });
      return { status: 'ignorado', motivo: prep.motivo };
    }
    ctx = prep.ctx;
    const ctxAtivo = prep.ctx;
    const obs = observarCancelamento(redis, job.chamadoId, {
      intervaloMs: deps.cancelamentoPollMs,
      // Sinal Redis só vale se o banco confirmar o silêncio (sinal atrasado de
      // um silêncio já desfeito não cancela esta execução).
      confirmar: () =>
        runInTenantContext(ds, job.tenantId, async (em) => {
          const linhas: Array<{ ia_silenciada: boolean }> = await em.query(
            'SELECT ia_silenciada FROM chamado WHERE id = $1 AND deleted_at IS NULL',
            [job.chamadoId],
          );
          return linhas[0]?.ia_silenciada === true;
        }),
      log,
    });
    observador = obs;
    // D-041: cancelamento detectado (sinal Redis, erro do provider ou releitura
    // da flag na Tx2). Uma vez `true`, nenhuma etapa seguinte roda e nada é aplicado.
    let cancelado = false;
    const checarCancelamento = async (): Promise<boolean> => {
      if (!cancelado && (await obs.verificarAgora())) cancelado = true;
      return cancelado;
    };

    // ---- Sincronização + provider (FORA da transação) ----------------------
    let resultado: AIProviderResult | null = null;
    let erro: string | null = null;
    // D-033: o que a execução gastou até um corte por limite (timeout/turnos/
    // budget) — gravado na ExecucaoIA falha; antes o custo dessas falhas sumia.
    let telemetriaFalha: TelemetriaParcial | undefined;
    try {
      await ctxAtivo.sincronizar(); // git clone/pull (specs/05 §3.2)
    } catch (err) {
      erro = motivoErro(err);
    }
    if (!erro) await checarCancelamento(); // D-041: silenciada durante o git sync
    // Prepara a working copy DESCARTÁVEL da resolução (specs/05 §6) — no-op se o
    // gate PRÉ-call fechou. Falha aqui NÃO derruba a triagem (best-effort): a
    // resolução simplesmente não acontece.
    if (!erro && !cancelado) {
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
    // lança (falha de mapa não derruba a triagem). D-041: o mapeamento inline NÃO
    // é abortado pelo silêncio (é do sistema-alvo, serve às próximas triagens e
    // tem timeout próprio); o cancelamento vale logo depois dele.
    if (!erro && !cancelado && deps.mapa && ctxAtivo.sistemaAlvoId) {
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
    if (!erro && !cancelado) await checarCancelamento(); // D-041: antes do provider
    if (!erro && !cancelado) {
      // D-014: agora que o git sync terminou, aponta a exploração NATIVA
      // (Read/Grep/Glob) para o checkout — `cwd` + fronteira do canUseTool.
      if (ctxAtivo.input.exploracao) {
        ctxAtivo.input.exploracao.checkoutDir = ctxAtivo.checkout();
      }
      // #16: baixa as imagens inline (prints) para o contexto MULTIMODAL —
      // best-effort (nunca lança), fora de transação.
      await ctxAtivo.carregarImagens();
      // D-041: o silêncio aborta a chamada pelo MESMO abort do timeout.
      ctxAtivo.input.sinalCancelamento = obs.signal;
      try {
        resultado = await provider.executarTriagem(ctxAtivo.input);
      } catch (err) {
        telemetriaFalha = telemetriaDoErro(err);
        if (err instanceof ErroTriagemCancelada || obs.cancelado()) cancelado = true;
        else erro = motivoErro(err);
      }
    }

    // ---- Resolução automática (branch/push/PR — I/O, FORA da transação) -----
    // Gate PÓS-call no PIPELINE (specs/05 §6), nunca no provider. Falha da
    // tentativa NÃO derruba o diagnóstico: vira nota interna de falha + ia_falhou.
    let resolucaoOutcome: ResultadoResolucao = { tipo: 'nenhuma' };
    let resultadoRegistro = resultado;
    if (resultado && !erro && !cancelado) await checarCancelamento();
    if (resultado && !erro && !cancelado) {
      try {
        resolucaoOutcome = await tentarResolver(
          resultado,
          ctxAtivo,
          prep.execucaoId,
          deps,
          job,
          checarCancelamento,
        );
      } catch (err) {
        if (!(err instanceof ErroTriagemCancelada)) throw err;
        cancelado = true; // D-041: silenciada antes do push — nada publicado
      }
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
    if (resultado && !erro && !cancelado) await checarCancelamento(); // antes da Tx2

    // ---- Tx2: aplicação + conclusão (ou falha + escalonamento) --------------
    // Despachante de NOTIFICAÇÕES (M9): captura, DENTRO da Tx2, os jobs traduzidos
    // pelo seam de auditoria a partir das mutações do aplicador (mensagens públicas
    // + transições). O flush (enfileiramento real) é PÓS-COMMIT e best-effort — só
    // ocorre se a Tx2 foi commitada, evitando notificar uma aplicação que sofreu
    // rollback (que aí escalona sem notificar). Notas internas/complexidade/`ia_*`
    // não notificam (o dispatcher filtra).
    let concluido = false;
    const despachanteNotif = new DespachanteNotificacoes(log);
    if (resultado && !cancelado) {
      const r = resultado;
      const rRegistro = resultadoRegistro ?? r;
      // Artefatos entregáveis (D-026) gerados pela IA via `artefato_gerar` —
      // buffers acumulados FORA da transação; o aplicador anexa em Tx2.
      const artefatos = ctxAtivo.artefatos();
      try {
        const aplicado = await runInTenantContext(ds, job.tenantId, async (em) => {
          // D-041 — REDE DE SEGURANÇA: relê a flag com lock da linha (serializa
          // com o `definirSilencioIa`). Silenciada → NADA é aplicado, mesmo que o
          // sinal Redis tenha se perdido.
          if (await chamadoSilenciadoComLock(em, job.chamadoId)) return false;
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
          return true;
        });
        if (aplicado) concluido = true;
        else cancelado = true;
      } catch (err) {
        erro = motivoErro(err); // falha na aplicação → escalona
      }
      if (concluido) await despachanteNotif.flush(); // notificações pós-commit
    }

    if (!concluido) {
      const erroFinal = erro ?? 'erro_desconhecido';
      // Telemetria a gravar: a parcial do corte ou, se o provider chegou a
      // responder (cancelado antes da Tx2), a completa da resposta descartada.
      const telemetria = telemetriaFalha ?? resultado?.telemetria;
      const resolucaoPublicada =
        resolucaoOutcome.tipo === 'sucesso'
          ? {
              branch: resolucaoOutcome.tentativa.branch ?? null,
              prUrl: resolucaoOutcome.tentativa.prUrl ?? null,
            }
          : null;
      const desfecho = await runInTenantContext(ds, job.tenantId, async (em) => {
        // D-041: silenciada (sinal OU flag relida agora) → CANCELADA, não falha:
        // sem `ia_falhou`, sem nota de escalonamento por erro.
        if (cancelado || (await chamadoSilenciadoComLock(em, job.chamadoId))) {
          await cancelarExecucao(em, prep.execucaoId, MOTIVO_CANCELAMENTO_IA_SILENCIADA, {
            acoes: prep.acoes,
            telemetriaParcial: telemetria,
          });
          await encerrarTriagemCancelada(
            em,
            {
              tenantId: job.tenantId,
              chamadoId: job.chamadoId,
              execucaoId: prep.execucaoId,
              resolucaoPublicada,
            },
            { log },
          );
          return 'cancelado' as const;
        }
        await falharExecucao(em, prep.execucaoId, erroFinal, {
          acoes: prep.acoes,
          telemetriaParcial: telemetriaFalha,
        });
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
        return 'falhou' as const;
      });
      if (desfecho === 'cancelado') {
        log('triagem cancelada (IA silenciada)', {
          chamadoId: job.chamadoId,
          execucaoId: prep.execucaoId,
          ...(erro ? { erroIgnorado: erro } : {}),
        });
        return { status: 'cancelado', execucaoId: prep.execucaoId, motivo: 'ia_silenciada' };
      }
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
    observador?.parar();
    if (ctx) await ctx.encerrar().catch(() => {});
    await liberarLockTenant(redis, job.tenantId, token).catch(() => {});
  }
}

/**
 * Avalia o gate PÓS-call e, se autorizado, executa a tentativa de resolução
 * (branch/push/PR). Devolve o desfecho para o aplicador registrar em Tx2. Só
 * lança `ErroTriagemCancelada` (D-041 — IA silenciada antes do push); qualquer
 * outra falha da tentativa vira `{ tipo: 'falha' }` (o diagnóstico segue intacto).
 */
async function tentarResolver(
  resultado: AIProviderResult,
  ctx: PreparacaoContexto,
  execucaoId: string,
  deps: DepsProcessador,
  job: JobTriagem,
  deveCancelar: () => Promise<boolean>,
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
        deveCancelar,
      },
    );
    return { tipo: 'sucesso', tentativa };
  } catch (err) {
    // D-041: cancelamento NÃO é falha da tentativa — sobe para o pipeline.
    if (err instanceof ErroTriagemCancelada) throw err;
    const motivo = motivoErro(err);
    log('resolucao: tentativa falhou', { chamadoId: job.chamadoId, motivo });
    return { tipo: 'falha', motivo };
  }
}

/**
 * D-041 — releitura de `chamado.ia_silenciada` com `FOR UPDATE` (dentro da
 * transação): serializa com o `definirSilencioIa`, que atualiza a mesma linha. Se
 * o silêncio commitou antes, vê `true`; se não, o silêncio espera esta transação
 * terminar (a triagem "chegou antes"). Chamado inexistente → `false` (o
 * aplicador/escalonamento já tratam).
 */
export async function chamadoSilenciadoComLock(
  em: EntityManager,
  chamadoId: string,
): Promise<boolean> {
  const linhas: Array<{ ia_silenciada: boolean }> = await em.query(
    'SELECT ia_silenciada FROM chamado WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [chamadoId],
  );
  return linhas[0]?.ia_silenciada === true;
}
