import { describe, it, expect, vi } from 'vitest';
import { DelayedError, type Job } from 'bullmq';
import { reagendarPorLockOcupado, MAX_ESPERAS_LOCK } from './espera-lock';

/**
 * Testes do reagendamento por lock ocupado (D-016): "recurso ocupado" não
 * consome tentativa (moveToDelayed + DelayedError); o guard-rail devolve o
 * controle ao fluxo de falha real após MAX_ESPERAS_LOCK reagendamentos.
 */

interface DadosJob {
  tenantId: string;
  esperasLock?: number;
}

function fakeJob(data: DadosJob): Job<DadosJob> {
  return {
    id: 'job-1',
    data,
    updateData: vi.fn(async (d: DadosJob) => {
      (fakeJob as unknown as Record<string, unknown>).ultimo = d;
    }),
    moveToDelayed: vi.fn(async () => {}),
  } as unknown as Job<DadosJob>;
}

const semLog = (): void => {};

describe('reagendarPorLockOcupado', () => {
  it('reagenda (moveToDelayed com o token) e lança DelayedError', async () => {
    const job = fakeJob({ tenantId: 't1' });
    await expect(reagendarPorLockOcupado(job, 'token-bull', semLog)).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(job.updateData).toHaveBeenCalledWith({ tenantId: 't1', esperasLock: 1 });
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      string,
    ];
    expect(token).toBe('token-bull');
    expect(ts).toBeGreaterThan(Date.now() + 25_000); // atraso ≥ ~30s
    expect(ts).toBeLessThan(Date.now() + 50_000); // atraso ≤ ~45s
  });

  it('incrementa o contador a cada reagendamento', async () => {
    const job = fakeJob({ tenantId: 't1', esperasLock: 4 });
    await expect(reagendarPorLockOcupado(job, 'tok', semLog)).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ tenantId: 't1', esperasLock: 5 });
  });

  it('guard-rail: além de MAX_ESPERAS_LOCK, retorna sem reagendar (tentativa conta)', async () => {
    const job = fakeJob({ tenantId: 't1', esperasLock: MAX_ESPERAS_LOCK });
    await expect(reagendarPorLockOcupado(job, 'tok', semLog)).resolves.toBeUndefined();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('sem token do worker, retorna sem reagendar (tentativa conta)', async () => {
    const job = fakeJob({ tenantId: 't1' });
    await expect(reagendarPorLockOcupado(job, undefined, semLog)).resolves.toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
