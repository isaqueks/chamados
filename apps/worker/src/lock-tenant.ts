import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Lock distribuído por TENANT (specs/05 §2: "um tenant não pode esgotar o
 * worker" — no máximo 1 execução de IA simultânea por tenant). SET NX PX para
 * adquirir; compare-and-del (Lua) para liberar apenas o próprio token; e
 * compare-and-pexpire (Lua) para RENOVAR o TTL enquanto a execução vive
 * (heartbeat — D-016).
 *
 * O TTL é CURTO de propósito: a garantia contra lock órfão NÃO é o shutdown
 * limpo (no Windows, `concurrently`/`tsx watch` matam o processo sem sinal),
 * e sim o heartbeat — se o processo morrer de qualquer jeito no meio de uma
 * execução, o lock órfão expira em ≤ `ttlMs` e o tenant volta a ser triável.
 * Execuções legítimas longas (mapa + triagem podem passar de 20 min) ficam
 * cobertas pela renovação contínua.
 */

const CHAVE = (tenantId: string): string => `chamados:lock:triagem:${tenantId}`;

/** Lua: só deleta se o valor bater com o token do dono (release seguro). */
const SCRIPT_LIBERAR = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** Lua: só renova o TTL se o valor bater com o token do dono. */
const SCRIPT_RENOVAR = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
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

/**
 * Renova o TTL do lock se (e somente se) ainda formos o dono.
 * Retorna `false` quando o lock foi perdido (expirou/outro dono).
 */
export async function renovarLockTenant(
  redis: Redis,
  tenantId: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  const r = await redis.eval(SCRIPT_RENOVAR, 1, CHAVE(tenantId), token, String(ttlMs));
  return r === 1;
}

export interface OpcoesHeartbeat {
  ttlMs: number;
  /** Intervalo entre renovações. Default: `ttlMs / 3` (duas renovações de folga). */
  renovacaoMs?: number;
  /** Notificado (uma única vez) se a renovação constatar que o lock foi perdido. */
  onPerda?: () => void;
}

/**
 * Mantém o lock vivo renovando o TTL a cada `renovacaoMs`. Retorna a função que
 * PARA o heartbeat — chamar no `finally`, antes de `liberarLockTenant`. Erros
 * transitórios do Redis não param o heartbeat (a próxima renovação tenta de
 * novo); a perda CONFIRMADA do lock (resposta 0 do Lua) para o heartbeat e
 * dispara `onPerda`. O timer usa `unref()` — nunca segura o processo vivo.
 */
export function manterLockVivo(
  redis: Redis,
  tenantId: string,
  token: string,
  opts: OpcoesHeartbeat,
): () => void {
  const intervalo = opts.renovacaoMs ?? Math.max(1_000, Math.floor(opts.ttlMs / 3));
  const timer = setInterval(() => {
    void renovarLockTenant(redis, tenantId, token, opts.ttlMs)
      .then((dono) => {
        if (!dono) {
          clearInterval(timer);
          opts.onPerda?.();
        }
      })
      .catch(() => {
        /* erro transitório do Redis: a próxima renovação tenta de novo */
      });
  }, intervalo);
  timer.unref?.();
  return () => clearInterval(timer);
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OpcoesEspera {
  ttlMs: number;
  esperaMaxMs: number;
  intervaloMs: number;
  /** Intervalo do heartbeat de renovação (default: `ttlMs / 3`). */
  renovacaoMs?: number;
}

/**
 * Adquire o lock esperando (poll) por até `esperaMaxMs` — como a concorrência
 * global é baixa (2) e a execução é serializada por tenant, no máximo um job
 * espera por vez. Retorna o token ou `null` se esgotar a espera (o chamador
 * devolve o job à fila — o registrador reagenda sem consumir tentativa).
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
