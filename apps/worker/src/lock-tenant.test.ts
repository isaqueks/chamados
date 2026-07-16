import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Redis from 'ioredis';
import { manterLockVivo, renovarLockTenant } from './lock-tenant';

/**
 * Testes do HEARTBEAT do lock por tenant (D-016): renovação periódica com TTL
 * curto — a garantia contra lock órfão quando o processo morre sem sinal
 * (Windows: `concurrently`/`tsx watch` matam com taskkill /F).
 */

function fakeRedis(evalImpl: (...args: unknown[]) => Promise<unknown>): Redis {
  return { eval: vi.fn(evalImpl) } as unknown as Redis;
}

describe('renovarLockTenant', () => {
  it('retorna true quando o Lua confirma a renovação (dono)', async () => {
    const redis = fakeRedis(async () => 1);
    await expect(renovarLockTenant(redis, 't1', 'tok', 90_000)).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('pexpire'),
      1,
      'chamados:lock:triagem:t1',
      'tok',
      '90000',
    );
  });

  it('retorna false quando o lock foi perdido (outro dono/expirado)', async () => {
    const redis = fakeRedis(async () => 0);
    await expect(renovarLockTenant(redis, 't1', 'tok', 90_000)).resolves.toBe(false);
  });
});

describe('manterLockVivo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renova o TTL a cada intervalo enquanto for o dono', async () => {
    const redis = fakeRedis(async () => 1);
    const parar = manterLockVivo(redis, 't1', 'tok', { ttlMs: 90_000, renovacaoMs: 30_000 });
    await vi.advanceTimersByTimeAsync(95_000);
    expect(redis.eval).toHaveBeenCalledTimes(3); // 30s, 60s, 90s
    parar();
  });

  it('para de renovar e notifica onPerda quando o lock é perdido', async () => {
    let chamadas = 0;
    const redis = fakeRedis(async () => (++chamadas >= 2 ? 0 : 1)); // perde na 2ª
    const onPerda = vi.fn();
    manterLockVivo(redis, 't1', 'tok', { ttlMs: 90_000, renovacaoMs: 30_000, onPerda });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(onPerda).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(2); // parou após a perda
  });

  it('parar() interrompe o heartbeat', async () => {
    const redis = fakeRedis(async () => 1);
    const parar = manterLockVivo(redis, 't1', 'tok', { ttlMs: 90_000, renovacaoMs: 30_000 });
    await vi.advanceTimersByTimeAsync(35_000);
    parar();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('erro transitório do Redis não para o heartbeat', async () => {
    let chamadas = 0;
    const redis = fakeRedis(async () => {
      chamadas += 1;
      if (chamadas === 1) throw new Error('ECONNRESET');
      return 1;
    });
    const onPerda = vi.fn();
    const parar = manterLockVivo(redis, 't1', 'tok', {
      ttlMs: 90_000,
      renovacaoMs: 30_000,
      onPerda,
    });
    await vi.advanceTimersByTimeAsync(95_000);
    expect(redis.eval).toHaveBeenCalledTimes(3); // continuou tentando
    expect(onPerda).not.toHaveBeenCalled();
    parar();
  });

  it('default do intervalo é ttlMs/3', async () => {
    const redis = fakeRedis(async () => 1);
    const parar = manterLockVivo(redis, 't1', 'tok', { ttlMs: 9_000 });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    parar();
  });
});
