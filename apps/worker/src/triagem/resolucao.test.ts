import { describe, it, expect } from 'vitest';
import { Natureza, Complexidade } from '@chamados/shared';
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
  it('fecha quando a natureza declarada é alteracao', () => {
    expect(portaResolucaoAberta({ ...base, naturezaDeclarada: Natureza.alteracao })).toBe(false);
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
    confianca: 0.9,
    confiancaMin: 0.7,
    temTentativa: true,
    repoConfigurado: true,
  };
  it('tenta quando todas as condições valem', () => {
    expect(deveTentarResolver(base)).toBe(true);
  });
  it('NÃO tenta com complexidade media', () => {
    expect(deveTentarResolver({ ...base, complexidade: Complexidade.medio })).toBe(false);
  });
  it('NÃO tenta com natureza efetiva alteracao', () => {
    expect(deveTentarResolver({ ...base, naturezaEfetiva: Natureza.alteracao })).toBe(false);
  });
  it('NÃO tenta abaixo do limiar de confiança', () => {
    expect(deveTentarResolver({ ...base, confianca: 0.5 })).toBe(false);
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
