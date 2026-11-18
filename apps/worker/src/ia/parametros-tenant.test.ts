import { describe, it, expect } from 'vitest';
import {
  IA_TIMEOUT_TENANT_MAX_MS,
  MODELO_IA_PADRAO,
  ESFORCO_IA_PADRAO,
  type AIProvider,
} from '@chamados/shared';
import {
  resolverParametrosIaTenant,
  resolverParametrosModeloTenant,
  modeloEfetivoDe,
} from './parametros-tenant';
import { ClaudeAgentProvider, type QueryFn } from './providers/claude-agent-provider';
import { FakeProvider } from './providers/fake-provider';

/**
 * Precedência da config de IA (D-044): tenant > env (`IA_MODELO`/`IA_ESFORCO`/
 * `IA_TIMEOUT_MS`, que viram o default do provider/`iaConfig`) > default do código.
 * Valor inválido no banco nunca derruba: cai no padrão da instalação.
 */
const PADRAO = { timeoutMs: 600_000, tetoTimeoutMs: IA_TIMEOUT_TENANT_MAX_MS };

const espiaoVazio: QueryFn = async function* () {
  yield { type: 'result', subtype: 'success' };
};

describe('resolverParametrosIaTenant', () => {
  it('tenant sem config (null/colunas nulas) → nenhum override e timeout do env', () => {
    for (const t of [null, undefined, { ia_modelo: null, ia_esforco: null, ia_timeout_ms: null }]) {
      const r = resolverParametrosIaTenant(t, PADRAO);
      expect(r.parametrosModelo).toEqual({});
      expect(r.timeoutMs).toBe(600_000);
      expect(r.descartados).toEqual([]);
    }
  });

  it('tenant definido vence o env', () => {
    const r = resolverParametrosIaTenant(
      { ia_modelo: 'claude-haiku-5-5', ia_esforco: 'low', ia_timeout_ms: 180_000 },
      PADRAO,
    );
    expect(r.parametrosModelo).toEqual({ modelo: 'claude-haiku-5-5', esforco: 'low' });
    expect(r.timeoutMs).toBe(180_000);
    expect(r.timeoutRebaixado).toBe(false);
  });

  it('valor inválido no banco cai no padrão (nunca lança) e é reportado', () => {
    const r = resolverParametrosIaTenant(
      { ia_modelo: 'claude opus; DROP', ia_esforco: 'turbo', ia_timeout_ms: 5 },
      PADRAO,
    );
    expect(r.parametrosModelo).toEqual({});
    expect(r.timeoutMs).toBe(600_000);
    expect(r.descartados).toEqual(['ia_modelo', 'ia_esforco', 'ia_timeout_ms']);
  });

  it('timeout acima do teto real é REBAIXADO ao teto (limiar de órfã baixado depois)', () => {
    const r = resolverParametrosIaTenant(
      { ia_timeout_ms: 15 * 60_000 },
      { timeoutMs: 600_000, tetoTimeoutMs: 8 * 60_000 },
    );
    expect(r.timeoutMs).toBe(8 * 60_000);
    expect(r.timeoutRebaixado).toBe(true);
  });

  it('resolverParametrosModeloTenant ignora o timeout (mapeamento tem limites próprios)', () => {
    expect(
      resolverParametrosModeloTenant({ ia_modelo: 'claude-fable-5-2', ia_timeout_ms: 60_000 }),
    ).toEqual({ parametrosModelo: { modelo: 'claude-fable-5-2' }, descartados: [] });
  });
});

describe('precedência ponta a ponta: tenant > env > default (modelo gravado em ExecucaoIA)', () => {
  it('provider com default do env: tenant vence; sem tenant, vale o env', () => {
    // `iaConfig.modelo/esforco` (env) são o default do provider em produção.
    const doEnv = new ClaudeAgentProvider({
      queryFn: espiaoVazio,
      modelo: 'claude-sonnet-5-5',
      esforco: 'medium',
    });
    const comTenant = resolverParametrosModeloTenant({ ia_modelo: 'claude-opus-5-5' });
    expect(modeloEfetivoDe(doEnv, comTenant.parametrosModelo)).toBe('claude-opus-5-5');
    expect(modeloEfetivoDe(doEnv, resolverParametrosModeloTenant(null).parametrosModelo)).toBe(
      'claude-sonnet-5-5',
    );
    expect(doEnv.esforcoEfetivo({})).toBe('medium');
    expect(doEnv.esforcoEfetivo({ esforco: 'max' })).toBe('max');
  });

  it('sem env nem tenant: default do código', () => {
    const semEnv = new ClaudeAgentProvider({ queryFn: espiaoVazio });
    expect(modeloEfetivoDe(semEnv, {})).toBe(MODELO_IA_PADRAO);
    expect(semEnv.esforcoEfetivo(undefined)).toBe(ESFORCO_IA_PADRAO);
  });

  it('provider sem override (fake) registra o próprio modelo, nunca o do tenant', () => {
    const fake: AIProvider = new FakeProvider();
    expect(modeloEfetivoDe(fake, { modelo: 'claude-opus-5-5' })).toBe(fake.modelo);
  });
});
