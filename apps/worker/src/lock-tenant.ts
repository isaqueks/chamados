import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Lock distribuído por TENANT (specs/05 §2: "um tenant não pode esgotar o
 * worker" — no máximo 1 execução de triagem simultânea por tenant). SET NX PX
 * para adquirir; compare-and-del (Lua) para liberar apenas o próprio token
 * (evita liberar o lock de outra execução após expiração/renovação).
 */

const CHAVE = (tenantId: string): string => `chamados:lock:triagem:${tenantId}`;

/** Lua: só deleta se o valor bater com o token do dono (release seguro). */
const SCRIPT_LIBERAR = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** Tenta adquirir o lock; retorna o token (dono) ou `null` se já tomado. */
export async function adquirirLockTenant(
  redis: Redis,
  tenantId: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();
  const r = await redis.set(CHAVE(tenantId), token, 'PX', ttlMs, 'NX');
  return r === 'OK' ? token : null;
}

/** Libera o lock apenas se o token bater (idempotente, best-effort). */
export async function liberarLockTenant(
  redis: Redis,
  tenantId: string,
  token: string,
): Promise<void> {
  await redis.eval(SCRIPT_LIBERAR, 1, CHAVE(tenantId), token);
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OpcoesEspera {
  ttlMs: number;
  esperaMaxMs: number;
  intervaloMs: number;
}

/**
 * Adquire o lock esperando (poll) por até `esperaMaxMs` — como a concorrência
 * global é baixa (2) e a execução é serializada por tenant, no máximo um job
 * espera por vez. Retorna o token ou `null` se esgotar a espera (o chamador
 * devolve o job à fila para retry).
 */
export async function adquirirLockComEspera(
  redis: Redis,
  tenantId: string,
  opts: OpcoesEspera,
): Promise<string | null> {
  const limite = Date.now() + opts.esperaMaxMs;
  for (;;) {
    const token = await adquirirLockTenant(redis, tenantId, opts.ttlMs);
    if (token) return token;
    if (Date.now() >= limite) return null;
    await dormir(opts.intervaloMs);
  }
}
