import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RedisSinalCancelamento } from '@chamados/db';
import { observarCancelamento, descartarSinalObsoleto } from './cancelamento';
import { ErroTriagemCancelada } from '../ia/erros';

/**
 * D-041: o observador do sinal de cancelamento (polling da chave Redis) aborta o
 * `AbortSignal` entregue ao provider — com Redis FAKE, como os testes do lock.
 */

function redisFake(inicial = false) {
  let sinal = inicial;
  const r = {
    exists: vi.fn(async () => (sinal ? 1 : 0)),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => {
      const tinha = sinal;
      sinal = false;
      return tinha ? 1 : 0;
    }),
  };
  return {
    redis: r as unknown as RedisSinalCancelamento & typeof r,
    ligar: () => {
      sinal = true;
    },
  };
}

describe('observarCancelamento', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborta o signal quando o polling encontra a chave (motivo ErroTriagemCancelada)', async () => {
    const { redis, ligar } = redisFake();
    const obs = observarCancelamento(redis, 'ch-1', { intervaloMs: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(obs.cancelado()).toBe(false);
    expect(obs.signal.aborted).toBe(false);

    ligar();
    await vi.advanceTimersByTimeAsync(1000);
    expect(obs.cancelado()).toBe(true);
    expect(obs.signal.reason).toBeInstanceOf(ErroTriagemCancelada);
    const chamadas = redis.exists.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(redis.exists.mock.calls.length).toBe(chamadas); // para de consultar após abortar
    obs.parar();
  });

  it('verificarAgora consulta na hora (pontos de checagem) e é idempotente', async () => {
    const { redis, ligar } = redisFake();
    const obs = observarCancelamento(redis, 'ch-1', { intervaloMs: 60_000 });
    await expect(obs.verificarAgora()).resolves.toBe(false);
    ligar();
    await expect(obs.verificarAgora()).resolves.toBe(true);
    await expect(obs.verificarAgora()).resolves.toBe(true);
    expect(obs.signal.aborted).toBe(true);
    obs.parar();
  });

  it('falha de Redis no polling é ignorada (best-effort; a Tx2 é a rede)', async () => {
    const r = {
      exists: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      set: vi.fn(),
      del: vi.fn(),
    } as unknown as RedisSinalCancelamento;
    const log = vi.fn();
    const obs = observarCancelamento(r, 'ch-1', { intervaloMs: 1000, log });
    await vi.advanceTimersByTimeAsync(3000);
    expect(obs.cancelado()).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('falha ao consultar'),
      expect.objectContaining({ chamadoId: 'ch-1' }),
    );
    obs.parar();
  });

  it('sinal sem confirmação do banco é obsoleto: apaga a chave e NÃO aborta', async () => {
    const { redis } = redisFake(true);
    const confirmar = vi.fn(async () => false);
    const obs = observarCancelamento(redis, 'ch-1', { intervaloMs: 1000, confirmar });
    expect(await obs.verificarAgora()).toBe(false);
    expect(obs.signal.aborted).toBe(false);
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
    obs.parar();
  });

  it('sinal confirmado pelo banco aborta', async () => {
    const { redis } = redisFake(true);
    const obs = observarCancelamento(redis, 'ch-1', {
      intervaloMs: 1000,
      confirmar: async () => true,
    });
    expect(await obs.verificarAgora()).toBe(true);
    expect(obs.signal.aborted).toBe(true);
    obs.parar();
  });

  it('Redis que não responde não trava: estoura o teto e vale "sem sinal"', async () => {
    const redis = {
      exists: vi.fn(() => new Promise<number>(() => {})),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(() => new Promise<number>(() => {})),
    } as unknown as RedisSinalCancelamento;
    const obs = observarCancelamento(redis, 'ch-1', { intervaloMs: 60_000, timeoutRedisMs: 500 });
    const consulta = obs.verificarAgora();
    await vi.advanceTimersByTimeAsync(600);
    expect(await consulta).toBe(false);
    expect(obs.signal.aborted).toBe(false);
    obs.parar();
  });

  it('parar() encerra o polling', async () => {
    const { redis } = redisFake();
    const obs = observarCancelamento(redis, 'ch-1', { intervaloMs: 1000 });
    obs.parar();
    await vi.advanceTimersByTimeAsync(5000);
    expect(redis.exists).not.toHaveBeenCalled();
  });
});

describe('descartarSinalObsoleto', () => {
  it('apaga a chave do chamado e nunca lança', async () => {
    const { redis } = redisFake(true);
    await descartarSinalObsoleto(redis, 'ch-1');
    expect(redis.del).toHaveBeenCalledWith('chamados:triagem:cancelar:ch-1');
    const quebrado = {
      del: vi.fn(async () => {
        throw new Error('fora');
      }),
    } as unknown as RedisSinalCancelamento;
    await expect(descartarSinalObsoleto(quebrado, 'ch-1')).resolves.toBeUndefined();
  });
});
