import { describe, it, expect } from 'vitest';
import {
  ESFORCOS_IA,
  ESFORCO_IA_PADRAO,
  MODELO_IA_PADRAO,
  MODELOS_IA_SUGERIDOS,
  IA_TIMEOUT_TENANT_MIN_MS,
  IA_TIMEOUT_TENANT_MAX_MS,
  IA_EXECUCAO_ORFA_PADRAO_MS,
  IA_MAPA_TIMEOUT_PADRAO_MS,
  calcularTetoTimeoutTriagemMs,
  lerPadroesIaAmbiente,
  normalizarEsforcoIa,
  normalizarModeloIa,
  validarConfigModeloIa,
  formatarMinutos,
} from './ia-config';

/** Modelo/esforço/timeout configuráveis por tenant (D-044). */
describe('normalizarModeloIa', () => {
  it('aceita os sugeridos e IDs livres no charset [a-z0-9.-]', () => {
    for (const m of MODELOS_IA_SUGERIDOS) expect(normalizarModeloIa(m.id)).toBe(m.id);
    expect(normalizarModeloIa('claude-nova-geracao-7.1')).toBe('claude-nova-geracao-7.1');
    expect(normalizarModeloIa('  Claude-Opus-5 ')).toBe('claude-opus-5');
  });

  it('recusa vazio, charset fora do permitido e IDs longos', () => {
    expect(normalizarModeloIa('')).toBeNull();
    expect(normalizarModeloIa('   ')).toBeNull();
    expect(normalizarModeloIa(undefined)).toBeNull();
    expect(normalizarModeloIa(42)).toBeNull();
    expect(normalizarModeloIa('claude opus')).toBeNull();
    expect(normalizarModeloIa('claude_opus')).toBeNull();
    expect(normalizarModeloIa('us.anthropic:claude')).toBeNull();
    expect(normalizarModeloIa('-claude')).toBeNull();
    expect(normalizarModeloIa('a'.repeat(65))).toBeNull();
    expect(normalizarModeloIa('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('a lista sugerida contém o default da instalação e os IDs atuais', () => {
    const ids = MODELOS_IA_SUGERIDOS.map((m) => m.id);
    expect(MODELO_IA_PADRAO).toBe('claude-opus-5');
    expect(ids).toEqual(
      expect.arrayContaining([
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-fable-5-2',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
      ]),
    );
  });
});

describe('normalizarEsforcoIa', () => {
  it('aceita os cinco níveis, sem sensibilidade a caixa/espaço', () => {
    for (const n of ESFORCOS_IA) expect(normalizarEsforcoIa(n)).toBe(n);
    expect(normalizarEsforcoIa(' XHIGH ')).toBe('xhigh');
  });
  it('inválido → null', () => {
    expect(normalizarEsforcoIa('altissimo')).toBeNull();
    expect(normalizarEsforcoIa('')).toBeNull();
    expect(normalizarEsforcoIa(null)).toBeNull();
  });
});

describe('teto do timeout por tenant (derivado do limiar de órfã — D-016/D-044)', () => {
  it('defaults: 30 min − mapa 10 − conclusão 3 − folga 2 = 15 min', () => {
    expect(IA_TIMEOUT_TENANT_MAX_MS).toBe(15 * 60_000);
    expect(
      calcularTetoTimeoutTriagemMs({
        execucaoOrfaMs: IA_EXECUCAO_ORFA_PADRAO_MS,
        mapaTimeoutMs: IA_MAPA_TIMEOUT_PADRAO_MS,
      }),
    ).toBe(15 * 60_000);
  });

  it('acompanha a config: limiar maior sobe o teto; mapa maior baixa', () => {
    expect(
      calcularTetoTimeoutTriagemMs({ execucaoOrfaMs: 3_600_000, mapaTimeoutMs: 600_000 }),
    ).toBe(45 * 60_000);
    expect(
      calcularTetoTimeoutTriagemMs({ execucaoOrfaMs: 1_800_000, mapaTimeoutMs: 900_000 }),
    ).toBe(10 * 60_000);
  });

  it('o teto mais a pior janela do mapeamento inline fica ABAIXO do limiar de órfã', () => {
    const orfa = IA_EXECUCAO_ORFA_PADRAO_MS;
    const mapa = IA_MAPA_TIMEOUT_PADRAO_MS;
    const teto = calcularTetoTimeoutTriagemMs({ execucaoOrfaMs: orfa, mapaTimeoutMs: mapa });
    expect(teto + mapa + 180_000).toBeLessThan(orfa);
  });

  it('nunca abaixo do mínimo configurável, mesmo com limiar minúsculo', () => {
    expect(calcularTetoTimeoutTriagemMs({ execucaoOrfaMs: 60_000, mapaTimeoutMs: 600_000 })).toBe(
      IA_TIMEOUT_TENANT_MIN_MS,
    );
  });
});

describe('lerPadroesIaAmbiente (env > default)', () => {
  it('sem env → defaults do código', () => {
    const p = lerPadroesIaAmbiente({});
    expect(p.modelo).toBe(MODELO_IA_PADRAO);
    expect(p.esforco).toBe(ESFORCO_IA_PADRAO);
    expect(p.timeoutMs).toBe(600_000);
    expect(p.tetoTimeoutTenantMs).toBe(IA_TIMEOUT_TENANT_MAX_MS);
  });

  it('env definido vence o default; inválido cai no default (não derruba)', () => {
    const p = lerPadroesIaAmbiente({
      IA_MODELO: ' claude-sonnet-5-5 ',
      IA_ESFORCO: 'LOW',
      IA_TIMEOUT_MS: '300000',
      MANUTENCAO_EXECUCAO_ORFA_MS: '3600000',
    });
    expect(p).toMatchObject({
      modelo: 'claude-sonnet-5-5',
      esforco: 'low',
      timeoutMs: 300_000,
      tetoTimeoutTenantMs: 45 * 60_000,
    });
    const q = lerPadroesIaAmbiente({ IA_MODELO: '  ', IA_ESFORCO: 'turbo', IA_TIMEOUT_MS: '-1' });
    expect(q).toMatchObject({ modelo: MODELO_IA_PADRAO, esforco: 'high', timeoutMs: 600_000 });
  });
});

describe('validarConfigModeloIa', () => {
  it('tudo vazio = padrão da instalação (nulls)', () => {
    expect(validarConfigModeloIa({ modelo: '', esforco: '  ', timeoutMs: null })).toEqual({
      ok: true,
      valor: { ia_modelo: null, ia_esforco: null, ia_timeout_ms: null },
    });
    expect(validarConfigModeloIa({})).toMatchObject({ ok: true });
  });

  it('valores válidos são normalizados', () => {
    expect(
      validarConfigModeloIa({ modelo: 'Claude-Haiku-5-5', esforco: 'MAX', timeoutMs: 300_000 }),
    ).toEqual({
      ok: true,
      valor: { ia_modelo: 'claude-haiku-5-5', ia_esforco: 'max', ia_timeout_ms: 300_000 },
    });
  });

  it('modelo/esforço inválidos → erro pt-BR', () => {
    const m = validarConfigModeloIa({ modelo: 'rm -rf /' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.erro).toMatch(/Modelo inválido/);
    const e = validarConfigModeloIa({ esforco: 'turbo' });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.erro).toMatch(/Esforço inválido/);
  });

  it('timeout fora de [1 min, teto] ou não inteiro → erro com os limites', () => {
    for (const t of [59_999, IA_TIMEOUT_TENANT_MAX_MS + 1, 90_000.5, Number.NaN]) {
      const r = validarConfigModeloIa({ timeoutMs: t });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erro).toContain('entre 1 minuto e 15 minutos');
    }
    expect(validarConfigModeloIa({ timeoutMs: 60_000 }).ok).toBe(true);
    expect(validarConfigModeloIa({ timeoutMs: IA_TIMEOUT_TENANT_MAX_MS }).ok).toBe(true);
  });

  it('respeita o teto informado (derivado do ambiente)', () => {
    expect(validarConfigModeloIa({ timeoutMs: 20 * 60_000 }, 45 * 60_000).ok).toBe(true);
    expect(validarConfigModeloIa({ timeoutMs: 20 * 60_000 }, 10 * 60_000).ok).toBe(false);
  });

  it('formatarMinutos', () => {
    expect(formatarMinutos(60_000)).toBe('1 minuto');
    expect(formatarMinutos(900_000)).toBe('15 minutos');
  });
});
