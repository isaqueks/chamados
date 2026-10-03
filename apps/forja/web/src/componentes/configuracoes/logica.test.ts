import { describe, expect, it } from 'vitest';
import { configuracoesGlobaisPadrao } from '@comum/config-projeto';
import { contarAjustes, validarConfiguracoes } from './logica';

describe('configurações globais (FJ-030 §2)', () => {
  it('o padrão é válido e não tem ajustes', () => {
    const p = configuracoesGlobaisPadrao();
    expect(validarConfiguracoes(p).ok).toBe(true);
    expect(contarAjustes(p, configuracoesGlobaisPadrao())).toBe(0);
  });

  it('erros traduzidos, por caminho do campo, incluindo campo vazio (NaN)', () => {
    const c = configuracoesGlobaisPadrao();
    c.concorrencia.implementacoes = Number.NaN;
    c.cota.five_hour = 1.5;
    c.limites.timeout_min.planejar = 0;
    const r = validarConfiguracoes(c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros['concorrencia.implementacoes']).toBe('informe um número');
    expect(r.erros['cota.five_hour']).toBe('máximo 1');
    expect(r.erros['limites.timeout_min.planejar']).toBe('mínimo 1');
  });

  it('regras entre campos: ciclos automáticos ≤ teto; orçamento por chamado ≥ etapa', () => {
    const c = configuracoesGlobaisPadrao();
    c.limites.ciclos.max_auto = 6;
    const r = validarConfiguracoes(c);
    expect(r.ok ? null : r.erros['limites.ciclos.max_auto']).toMatch(/total/);

    const d = configuracoesGlobaisPadrao();
    d.limites.orcamento_usd.por_chamado = 10;
    const s = validarConfiguracoes(d);
    expect(s.ok ? null : s.erros['limites.orcamento_usd.por_chamado']).toMatch(/etapa/);
  });

  it('conta os ajustes em relação ao padrão', () => {
    const c = configuracoesGlobaisPadrao();
    c.gates.plano = 'sempre';
    c.modelos.subagentes.esforco = 'max';
    expect(contarAjustes(c, configuracoesGlobaisPadrao())).toBe(2);
  });
});
