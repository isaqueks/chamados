import { describe, it, expect } from 'vitest';
import { Natureza, Complexidade, ConfiancaAnalise } from '@chamados/shared';
import { portaResolucaoAberta, deveTentarResolver } from './resolucao';

/**
 * Gate de RESOLUÇÃO automática (specs/05 §6) — puro e testável sem infra. Prova
 * que TODAS as condições são exigidas e que o gate vive no pipeline, não no provider.
 */

describe('portaResolucaoAberta (gate PRÉ-call)', () => {
  const base = {
    tenantHabilitado: true,
    naturezaDeclarada: Natureza.problema,
    repoConfigurado: true,
  };
  it('abre quando tenant habilitado + problema + repo', () => {
    expect(portaResolucaoAberta(base)).toBe(true);
  });
  it('fecha quando o tenant desabilitou', () => {
    expect(portaResolucaoAberta({ ...base, tenantHabilitado: false })).toBe(false);
  });
  it('abre também para natureza declarada alteracao (D-023)', () => {
    expect(portaResolucaoAberta({ ...base, naturezaDeclarada: Natureza.alteracao })).toBe(true);
  });
  it('fecha para natureza declarada duvida', () => {
    expect(portaResolucaoAberta({ ...base, naturezaDeclarada: Natureza.duvida })).toBe(false);
  });
  it('fecha quando não há repositório configurado', () => {
    expect(portaResolucaoAberta({ ...base, repoConfigurado: false })).toBe(false);
  });
});

describe('deveTentarResolver (gate PÓS-call)', () => {
  const base = {
    tenantHabilitado: true,
    naturezaEfetiva: Natureza.problema,
    complexidade: Complexidade.facil,
    compreendido: true,
    confianca: ConfiancaAnalise.alta,
    confiancaMin: ConfiancaAnalise.alta,
    temTentativa: true,
    repoConfigurado: true,
  };
  it('tenta quando todas as condições valem', () => {
    expect(deveTentarResolver(base)).toBe(true);
  });
  it('NÃO tenta com complexidade media', () => {
    expect(deveTentarResolver({ ...base, complexidade: Complexidade.medio })).toBe(false);
  });
  it('tenta também com natureza efetiva alteracao (D-023: alteração simples + facil)', () => {
    expect(deveTentarResolver({ ...base, naturezaEfetiva: Natureza.alteracao })).toBe(true);
  });
  it('NÃO tenta com natureza efetiva duvida', () => {
    expect(deveTentarResolver({ ...base, naturezaEfetiva: Natureza.duvida })).toBe(false);
  });
  it('NÃO tenta abaixo do limiar de confiança (D-025: categórica, baixa < media < alta)', () => {
    expect(deveTentarResolver({ ...base, confianca: ConfiancaAnalise.media })).toBe(false);
    expect(deveTentarResolver({ ...base, confianca: ConfiancaAnalise.baixa })).toBe(false);
    // Limiar rebaixado pelo tenant: media passa, baixa segue barrada.
    expect(
      deveTentarResolver({
        ...base,
        confianca: ConfiancaAnalise.media,
        confiancaMin: ConfiancaAnalise.media,
      }),
    ).toBe(true);
    expect(
      deveTentarResolver({
        ...base,
        confianca: ConfiancaAnalise.baixa,
        confiancaMin: ConfiancaAnalise.media,
      }),
    ).toBe(false);
  });
  it('NÃO tenta se não compreendeu', () => {
    expect(deveTentarResolver({ ...base, compreendido: false })).toBe(false);
  });
  it('NÃO tenta sem tentativa do provider', () => {
    expect(deveTentarResolver({ ...base, temTentativa: false })).toBe(false);
  });
  it('NÃO tenta com o tenant desabilitado', () => {
    expect(deveTentarResolver({ ...base, tenantHabilitado: false })).toBe(false);
  });
});
