import { describe, it, expect, vi } from 'vitest';
import {
  chaveCancelamentoTriagem,
  sinalizarCancelamentoTriagem,
  cancelamentoSinalizado,
  limparSinalCancelamento,
  removerTriagensPendentes,
  TTL_SINAL_CANCELAMENTO_MS,
  type RedisSinalCancelamento,
  type FilaComJobs,
} from './cancelamento-triagem';

/**
 * D-041: contrato do sinal de cancelamento da triagem (chave Redis com TTL por
 * chamado) e da remoção dos jobs pendentes do chamado — sem Redis real.
 */

function redisFake(): RedisSinalCancelamento & { dados: Map<string, { v: string; ttl: number }> } {
  const dados = new Map<string, { v: string; ttl: number }>();
  return {
    dados,
    set: vi.fn(async (k: string, v: string, _modo: 'PX', ttl: number) => {
      dados.set(k, { v, ttl });
      return 'OK';
    }),
    exists: vi.fn(async (k: string) => (dados.has(k) ? 1 : 0)),
    del: vi.fn(async (k: string) => (dados.delete(k) ? 1 : 0)),
  };
}

const CH_A = '11111111-1111-4111-8111-111111111111';
const CH_B = '22222222-2222-4222-8222-222222222222';

describe('sinal de cancelamento da triagem (D-041)', () => {
  it('a chave é POR CHAMADO (UUID) — nunca compartilhada entre chamados/tenants', () => {
    expect(chaveCancelamentoTriagem(CH_A)).toBe(`chamados:triagem:cancelar:${CH_A}`);
    expect(chaveCancelamentoTriagem(CH_A)).not.toBe(chaveCancelamentoTriagem(CH_B));
  });

  it('sinalizar grava com TTL (PX); consultar vê só o chamado sinalizado; limpar apaga', async () => {
    const r = redisFake();
    await sinalizarCancelamentoTriagem(r, CH_A);
    expect(r.set).toHaveBeenCalledWith(
      chaveCancelamentoTriagem(CH_A),
      expect.any(String),
      'PX',
      TTL_SINAL_CANCELAMENTO_MS,
    );
    expect(TTL_SINAL_CANCELAMENTO_MS).toBeGreaterThan(30 * 60_000); // > limiar de órfã
    await expect(cancelamentoSinalizado(r, CH_A)).resolves.toBe(true);
    await expect(cancelamentoSinalizado(r, CH_B)).resolves.toBe(false);
    await limparSinalCancelamento(r, CH_A);
    await expect(cancelamentoSinalizado(r, CH_A)).resolves.toBe(false);
  });
});

describe('removerTriagensPendentes (D-041)', () => {
  function job(id: string, falha = false) {
    return {
      id,
      remove: vi.fn(async () => {
        if (falha) throw new Error('job ativo');
      }),
    };
  }

  it('remove só os pendentes do prefixo do chamado (inclui manual) e tolera corrida', async () => {
    const doA = job(`${CH_A}__m1`);
    const manualA = job(`${CH_A}__manual__123`);
    const corrida = job(`${CH_A}__m2`, true);
    const doB = job(`${CH_B}__m1`);
    const fila: FilaComJobs = { getJobs: vi.fn(async () => [doA, manualA, corrida, doB]) };

    await expect(removerTriagensPendentes(fila, `${CH_A}__`)).resolves.toBe(2);
    expect(fila.getJobs).toHaveBeenCalledWith(['delayed', 'wait', 'paused', 'prioritized']);
    expect(doA.remove).toHaveBeenCalled();
    expect(manualA.remove).toHaveBeenCalled();
    expect(doB.remove).not.toHaveBeenCalled();
  });
});
