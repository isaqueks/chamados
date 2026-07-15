import type { DataSource } from 'typeorm';
import { IsNull } from 'typeorm';
import type Redis from 'ioredis';
import { Papel, StatusChamado, type AIProvider, type AIProviderResult } from '@chamados/shared';
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
import { aplicarResultado, escalarParaHumano } from './aplicador';
import { motivoErro } from '../ia/erros';
import { adquirirLockComEspera, liberarLockTenant, type OpcoesEspera } from '../lock-tenant';

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
  lock: OpcoesEspera;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export type ResultadoProcessamento =
  | { status: 'concluido'; execucaoId: string }
  | { status: 'falhou'; execucaoId: string; erro: string }
  | { status: 'ignorado'; motivo: 'idempotente' | 'chamado_inexistente' };

/** Preparação (Tx1): idempotência, transição, abertura da execução e do contexto. */
type Preparacao =
  | { skip: true; motivo: 'idempotente' | 'chamado_inexistente' }
  | { skip: false; execucaoId: string; ctx: PreparacaoContexto; acoes: unknown[] };

export async function processarTriagem(
  job: JobTriagem,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  const { ds, redis, provider, log } = deps;
  const manual = job.gatilho === 'reprocessamento_manual';

  const token = await adquirirLockComEspera(redis, job.tenantId, deps.lock);
  if (!token) {
    // Devolve o job à fila (BullMQ faz retry com backoff) — não fura o limite.
    throw new Error('lock_tenant_indisponivel');
  }

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
          entrada: {
            ultima_mensagem_id: job.ultimaMensagemId,
            gatilho: job.gatilho,
            titulo: prepCtx.input.contexto.titulo,
            natureza_declarada: prepCtx.input.contexto.naturezaDeclarada,
            mensagens_publicas: prepCtx.input.contexto.timeline.length,
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

    // ---- Sincronização + provider (FORA da transação) ----------------------
    let resultado: AIProviderResult | null = null;
    let erro: string | null = null;
    try {
      await ctx.sincronizar(); // git clone/pull (specs/05 §3.2)
    } catch (err) {
      erro = motivoErro(err);
    }
    if (!erro) {
      try {
        resultado = await provider.executarTriagem(ctx.input);
      } catch (err) {
        erro = motivoErro(err);
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
      try {
        await runInTenantContext(ds, job.tenantId, async (em) => {
          await aplicarResultado(
            em,
            {
              tenantId: job.tenantId,
              chamadoId: job.chamadoId,
              execucaoId: prep.execucaoId,
              resultado: r,
            },
            { log, despachante: despachanteNotif },
          );
          await concluirExecucao(em, prep.execucaoId, r, prep.acoes);
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
    if (ctx) await ctx.encerrar().catch(() => {});
    await liberarLockTenant(redis, job.tenantId, token).catch(() => {});
  }
}
