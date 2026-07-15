import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  runInTenantContext,
  listarTenantsAtivos,
  fecharChamadosResolvidosVencidos,
  DespachanteNotificacoes,
} from '@chamados/db';

/**
 * Processador do job `manutencao` (M10 — specs/04 §8.1): auto-fechamento de
 * chamados `resolvido` vencidos, varrendo TODOS os tenants ativos.
 *
 * Fluxo por execução:
 *  1. LOCK global (Redis SET NX PX) — se outra instância já roda a varredura, sai
 *     sem duplicar trabalho (idempotência entre instâncias concorrentes).
 *  2. Enumera os tenants ativos via a função SECURITY DEFINER (fora de contexto
 *     RLS — o role da app não lista a tabela `tenant`).
 *  3. Para cada tenant: `runInTenantContext` + `fecharChamadosResolvidosVencidos`
 *     com um `DespachanteNotificacoes` injetado (o cliente é notificado do
 *     fechamento). As notificações são enfileiradas PÓS-COMMIT (`flush`).
 *
 * A varredura em si é idempotente (só toca `resolvido` vencido); o lock evita
 * apenas o desperdício de duas instâncias varrerem ao mesmo tempo.
 */

/** Chave do lock global da varredura (exportada para o smoke testar concorrência). */
export const CHAVE_LOCK_MANUTENCAO = 'chamados:lock:manutencao';
const CHAVE_LOCK = CHAVE_LOCK_MANUTENCAO;

/** Lua: só deleta o lock se o token bater (release seguro do próprio dono). */
const SCRIPT_LIBERAR = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export interface DepsManutencao {
  ds: DataSource;
  redis: Redis;
  /** TTL do lock global da varredura (deve exceder a duração esperada). */
  lockTtlMs: number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ResultadoManutencao {
  /** `false` quando o lock estava ocupado (outra instância varrendo). */
  executou: boolean;
  tenants: number;
  fechados: number;
}

/**
 * Executa uma varredura de auto-fechamento. Retorna o resumo (para logs/smoke).
 * Best-effort por tenant: uma falha em um tenant é registrada e não interrompe
 * os demais.
 */
export async function executarManutencao(deps: DepsManutencao): Promise<ResultadoManutencao> {
  const token = randomUUID();
  const adquiriu = await deps.redis.set(CHAVE_LOCK, token, 'PX', deps.lockTtlMs, 'NX');
  if (adquiriu !== 'OK') {
    deps.log('manutencao: lock ocupado — outra instância está varrendo, pulando');
    return { executou: false, tenants: 0, fechados: 0 };
  }

  try {
    const tenants = await listarTenantsAtivos(deps.ds);
    let fechados = 0;
    for (const tenantId of tenants) {
      try {
        const despachante = new DespachanteNotificacoes(deps.log);
        const res = await runInTenantContext(deps.ds, tenantId, (em) =>
          fecharChamadosResolvidosVencidos(em, tenantId, { despachante }),
        );
        // Enfileira as notificações de fechamento PÓS-COMMIT (best-effort).
        await despachante.flush();
        if (res.fechados.length > 0) {
          fechados += res.fechados.length;
          deps.log('manutencao: chamados auto-fechados', {
            tenantId,
            quantidade: res.fechados.length,
          });
        }
      } catch (err) {
        deps.log('manutencao: falha ao varrer tenant (ignorado)', {
          tenantId,
          erro: (err as Error).message,
        });
      }
    }
    return { executou: true, tenants: tenants.length, fechados };
  } finally {
    await deps.redis.eval(SCRIPT_LIBERAR, 1, CHAVE_LOCK, token).catch(() => {
      /* release best-effort: o TTL cobre o lock se o del falhar */
    });
  }
}
