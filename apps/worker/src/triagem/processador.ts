import type { DataSource } from 'typeorm';
import { IsNull } from 'typeorm';
import type Redis from 'ioredis';
import { Papel, type AIProvider, type AIProviderResult } from '@chamados/shared';
import {
  runInTenantContext,
  criarExecucao,
  marcarExecutando,
  concluirExecucao,
  falharExecucao,
  existeConcluidaParaMensagem,
  gravarEvento,
  UsuarioSchema,
  ChamadoSchema,
  type JobTriagem,
} from '@chamados/db';
import { montarInput } from './contexto';
import { motivoErro } from '../ia/erros';
import { adquirirLockComEspera, liberarLockTenant, type OpcoesEspera } from '../lock-tenant';

/**
 * PROCESSADOR da fila `triagem-ia` (M6 — infra, specs/05 §3.1). Consome o job e:
 *   1. adquire o LOCK por tenant (1 execução simultânea por tenant);
 *   2. idempotência: descarta se já há `ExecucaoIA` concluída para o par
 *      (chamado, última mensagem) — exceto reprocessamento manual (specs/05 §2);
 *   3. abre `ExecucaoIA` (na_fila → executando) + evento `ia_iniciou`;
 *   4. monta o contexto MÍNIMO (chamado + timeline pública + metadados do
 *      sistema-alvo SEM credenciais) via `runInTenantContext`;
 *   5. chama o provider com HANDLES de ferramenta STUB (no-op logando em `acoes`);
 *   6. grava resultado bruto + telemetria (`concluido`) OU erro (`falhou` +
 *      evento `ia_falhou`; timeout/budget viram erro='timeout'/'budget_excedido').
 *
 * NÃO aplica o resultado ao chamado (mensagens/status/classificação são M7). O
 * provider é chamado FORA da transação (não segura conexão de BD durante I/O).
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

/** Preparação (Tx1): idempotência, abertura da execução e montagem do input. */
type Preparacao =
  | { skip: true; motivo: 'idempotente' | 'chamado_inexistente' }
  | {
      skip: false;
      execucaoId: string;
      input: NonNullable<Awaited<ReturnType<typeof montarInput>>>;
      acoes: unknown[];
    };

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

  try {
    // ---- Tx1: idempotência + abertura da ExecucaoIA + montagem do input -----
    const acoes: unknown[] = [];
    const prep = await runInTenantContext(ds, job.tenantId, async (em): Promise<Preparacao> => {
      if (!manual && (await existeConcluidaParaMensagem(em, job.chamadoId, job.ultimaMensagemId))) {
        return { skip: true, motivo: 'idempotente' };
      }
      const chamado = await em.findOne(ChamadoSchema, {
        where: { id: job.chamadoId, deleted_at: IsNull() },
      });
      if (!chamado) return { skip: true, motivo: 'chamado_inexistente' };

      const input = await montarInput(em, job.chamadoId, {
        acoes,
        log,
        limites: deps.limites,
      });
      if (!input) return { skip: true, motivo: 'chamado_inexistente' };

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
            titulo: input.contexto.titulo,
            natureza_declarada: input.contexto.naturezaDeclarada,
            mensagens_publicas: input.contexto.timeline.length,
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

      return { skip: false, execucaoId, input, acoes };
    });

    if (prep.skip) {
      log('triagem ignorada', { chamadoId: job.chamadoId, motivo: prep.motivo });
      return { status: 'ignorado', motivo: prep.motivo };
    }

    // ---- Provider (FORA da transação) --------------------------------------
    let resultado: AIProviderResult | null = null;
    let erro: string | null = null;
    try {
      resultado = await provider.executarTriagem(prep.input);
    } catch (err) {
      erro = motivoErro(err);
    }

    // ---- Tx2: conclusão OU falha (+ evento ia_falhou) ----------------------
    await runInTenantContext(ds, job.tenantId, async (em) => {
      if (resultado) {
        await concluirExecucao(em, prep.execucaoId, resultado, acoes);
      } else {
        await falharExecucao(em, prep.execucaoId, erro ?? 'erro_desconhecido', { acoes });
        const atorIa = await em.findOne(UsuarioSchema, { where: { papel: Papel.agente_ia } });
        await gravarEvento(em, {
          tipo: 'ia_falhou',
          chamado_id: job.chamadoId,
          ator_id: atorIa?.id ?? null,
          execucao_ia_id: prep.execucaoId,
          dados: { erro: erro ?? 'erro_desconhecido' },
        });
      }
    });

    if (resultado) {
      log('triagem concluída', { chamadoId: job.chamadoId, execucaoId: prep.execucaoId });
      return { status: 'concluido', execucaoId: prep.execucaoId };
    }
    log('triagem falhou', { chamadoId: job.chamadoId, execucaoId: prep.execucaoId, erro });
    return { status: 'falhou', execucaoId: prep.execucaoId, erro: erro ?? 'erro_desconhecido' };
  } finally {
    await liberarLockTenant(redis, job.tenantId, token).catch(() => {});
  }
}
