import { describe, it, expect } from 'vitest';
import type { EntityManager } from 'typeorm';
import { IA_TIMEOUT_TENANT_MAX_MS } from '@chamados/shared';
import { atualizarConfigModeloIa, atualizarConfigGeral } from './config-service';
import { TenantSchema } from '../entities/tenant';

/**
 * Fronteira de gravação da config de modelo/esforço/timeout da IA (D-044). O
 * isolamento cross-tenant real (RLS) é provado no `smoke:rls`; aqui, com um
 * EntityManager falso, garante-se que valor inválido NUNCA chega ao banco e que
 * o UPDATE é escopado pelo `id` do tenant.
 */
function emFalso() {
  const updates: Array<{ alvo: unknown; criterio: unknown; valores: unknown }> = [];
  const em = {
    update: async (alvo: unknown, criterio: unknown, valores: unknown) => {
      updates.push({ alvo, criterio, valores });
      return { affected: 1 };
    },
  } as unknown as EntityManager;
  return { em, updates };
}

describe('atualizarConfigModeloIa (D-044)', () => {
  it('grava valores normalizados, escopado ao tenant', async () => {
    const { em, updates } = emFalso();
    const r = await atualizarConfigModeloIa(em, 't-1', {
      modelo: ' Claude-Sonnet-5-5 ',
      esforco: 'XHIGH',
      timeoutMs: 300_000,
    });
    expect(r.ok).toBe(true);
    expect(updates).toEqual([
      {
        alvo: TenantSchema,
        criterio: { id: 't-1' },
        valores: { ia_modelo: 'claude-sonnet-5-5', ia_esforco: 'xhigh', ia_timeout_ms: 300_000 },
      },
    ]);
  });

  it('campos vazios voltam ao padrão da instalação (null)', async () => {
    const { em, updates } = emFalso();
    await atualizarConfigModeloIa(em, 't-1', { modelo: '', esforco: null });
    expect(updates[0]?.valores).toEqual({ ia_modelo: null, ia_esforco: null, ia_timeout_ms: null });
  });

  it('valor inválido NÃO grava e devolve erro pt-BR', async () => {
    for (const entrada of [
      { modelo: 'claude opus' },
      { esforco: 'turbo' },
      { timeoutMs: 30_000 },
      { timeoutMs: IA_TIMEOUT_TENANT_MAX_MS + 60_000 },
    ]) {
      const { em, updates } = emFalso();
      const r = await atualizarConfigModeloIa(em, 't-1', entrada);
      expect(r.ok).toBe(false);
      expect(updates).toHaveLength(0);
    }
  });

  it('o teto vem do chamador (derivado do ambiente)', async () => {
    const { em, updates } = emFalso();
    const r = await atualizarConfigModeloIa(em, 't-1', { timeoutMs: 30 * 60_000 }, 45 * 60_000);
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
  });
});

describe('atualizarConfigGeral — prazo de aprovação do cliente (D-042)', () => {
  it('grava o prazo dentro da faixa 1–365, escopado ao tenant', async () => {
    const { em, updates } = emFalso();
    await atualizarConfigGeral(em, 't-1', {
      dias_fechamento_automatico: 7,
      ia_resolucao_automatica_habilitada: true,
    });
    expect(updates[0]?.criterio).toEqual({ id: 't-1' });
    expect(updates[0]?.valores).toMatchObject({ dias_fechamento_automatico: 7 });
  });

  it('clamp defensivo: abaixo de 1 → 1; acima de 365 → 365', async () => {
    for (const [entrada, gravado] of [
      [0, 1],
      [1000, 365],
      [12.7, 12],
    ] as const) {
      const { em, updates } = emFalso();
      await atualizarConfigGeral(em, 't-1', {
        dias_fechamento_automatico: entrada,
        ia_resolucao_automatica_habilitada: false,
      });
      expect(updates[0]?.valores).toMatchObject({ dias_fechamento_automatico: gravado });
    }
  });
});
