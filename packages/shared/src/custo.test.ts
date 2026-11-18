import { describe, it, expect } from 'vitest';
import { EstimativaCusto } from './enums';
import {
  CUSTO_FINAL_MAX,
  FAIXAS_ESTIMATIVA_CUSTO,
  ORDEM_ESTIMATIVA_CUSTO,
  custoDoBanco,
  custoParaBanco,
  detalheEventoCusto,
  ehEstimativaCusto,
  faixaEstimativaCusto,
  formatarBrl,
  parsearValorBrl,
  rotuloEstimativaCusto,
  validarCustoFinal,
  valorParaCampo,
} from './custo';

/** Estimativa de custo e custo final (D-043). */
describe('EstimativaCusto — enum e faixas', () => {
  it('tem exatamente os seis códigos do pedido, todos com faixa e na ordem de exibição', () => {
    expect(Object.values(EstimativaCusto)).toEqual(['A', 'B', 'C', 'D', 'E', 'I']);
    expect(Object.keys(FAIXAS_ESTIMATIVA_CUSTO).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'I']);
    expect([...ORDEM_ESTIMATIVA_CUSTO].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'I']);
  });

  it('limites numéricos das faixas', () => {
    expect(FAIXAS_ESTIMATIVA_CUSTO.A).toMatchObject({ min: 50, max: 100 });
    expect(FAIXAS_ESTIMATIVA_CUSTO.B).toMatchObject({ min: 100, max: 200 });
    expect(FAIXAS_ESTIMATIVA_CUSTO.C).toMatchObject({ min: 200, max: 400 });
    expect(FAIXAS_ESTIMATIVA_CUSTO.D).toMatchObject({ min: 400, max: 600 });
    expect(FAIXAS_ESTIMATIVA_CUSTO.E).toMatchObject({ min: 600, max: null });
    expect(FAIXAS_ESTIMATIVA_CUSTO.I).toMatchObject({ min: 0, max: 0 });
  });

  it('rótulo canônico com código; Isento sem o código', () => {
    expect(rotuloEstimativaCusto(EstimativaCusto.B)).toBe('B · R$ 100 a R$ 200');
    expect(rotuloEstimativaCusto(EstimativaCusto.E)).toBe('E · acima de R$ 600');
    expect(rotuloEstimativaCusto(EstimativaCusto.I)).toBe('Isento (R$ 0)');
    expect(faixaEstimativaCusto(EstimativaCusto.A)).toBe('R$ 50 a R$ 100');
  });

  it('ehEstimativaCusto aceita só os códigos (maiúsculos)', () => {
    expect(ehEstimativaCusto('C')).toBe(true);
    expect(ehEstimativaCusto('c')).toBe(false);
    expect(ehEstimativaCusto('F')).toBe(false);
    expect(ehEstimativaCusto(null)).toBe(false);
  });
});

describe('parsearValorBrl — entrada pt-BR', () => {
  const ok = (s: string) => {
    const r = parsearValorBrl(s);
    if (!r.ok) throw new Error(`esperava ok para "${s}", veio ${r.motivo}`);
    return r.valor;
  };
  const motivo = (s: string) => {
    const r = parsearValorBrl(s);
    return r.ok ? 'ok' : r.motivo;
  };

  it('vírgula decimal e ponto de milhar', () => {
    expect(ok('1.234,56')).toBe(1234.56);
    expect(ok('1234,56')).toBe(1234.56);
    expect(ok('99,9')).toBe(99.9);
    expect(ok(',5')).toBe(0.5);
    expect(ok('1.000.000,00')).toBe(1000000);
  });

  it('inteiros, "R$" e espaços (inclusive NBSP)', () => {
    expect(ok('150')).toBe(150);
    expect(ok('R$ 150,00')).toBe(150);
    expect(ok('R$\u00a01.500')).toBe(1500);
    expect(ok('0')).toBe(0);
    expect(ok('0,00')).toBe(0);
  });

  it('sem vírgula: grupos de 3 são milhar; um ponto com 1–2 casas é decimal', () => {
    expect(ok('1.500')).toBe(1500);
    expect(ok('150.5')).toBe(150.5);
    expect(ok('150.50')).toBe(150.5);
  });

  it('recusa negativos, formato inválido, mais de 2 casas e vazio', () => {
    expect(motivo('-10')).toBe('negativo');
    expect(motivo('-10,50')).toBe('negativo');
    expect(motivo('abc')).toBe('formato_invalido');
    expect(motivo('1,2,3')).toBe('formato_invalido');
    expect(motivo('12.34.5')).toBe('formato_invalido');
    expect(motivo('1.23,4')).toBe('formato_invalido');
    expect(motivo('10,')).toBe('formato_invalido');
    expect(motivo('10,555')).toBe('casas_decimais');
    expect(motivo('10.555,1')).toBe('ok');
    expect(motivo('')).toBe('vazio');
    expect(motivo('  R$ ')).toBe('vazio');
  });

  it('limite do numeric(12,2)', () => {
    expect(ok('9.999.999.999,99')).toBe(CUSTO_FINAL_MAX);
    expect(motivo('10.000.000.000,00')).toBe('acima_do_limite');
  });
});

describe('validarCustoFinal — número vindo da API', () => {
  it('aceita 0 e valores com até 2 casas (tolerante ao ponto flutuante)', () => {
    expect(validarCustoFinal(0)).toEqual({ ok: true, valor: 0 });
    expect(validarCustoFinal(0.1 + 0.2)).toEqual({ ok: true, valor: 0.3 });
    expect(validarCustoFinal(19.99)).toEqual({ ok: true, valor: 19.99 });
    expect(validarCustoFinal(1234.5)).toEqual({ ok: true, valor: 1234.5 });
  });

  it('recusa negativo, NaN/Infinity, 3 casas e acima do teto', () => {
    expect(validarCustoFinal(-1)).toEqual({ ok: false, motivo: 'negativo' });
    expect(validarCustoFinal(Number.NaN)).toEqual({ ok: false, motivo: 'formato_invalido' });
    expect(validarCustoFinal(Infinity)).toEqual({ ok: false, motivo: 'formato_invalido' });
    expect(validarCustoFinal(1.005)).toEqual({ ok: false, motivo: 'casas_decimais' });
    expect(validarCustoFinal(CUSTO_FINAL_MAX + 1)).toEqual({
      ok: false,
      motivo: 'acima_do_limite',
    });
  });
});

describe('formatação e conversões', () => {
  it('formatarBrl usa padrão pt-BR com espaço comum', () => {
    expect(formatarBrl(1234.5)).toBe('R$ 1.234,50');
    expect(formatarBrl(0)).toBe('R$ 0,00');
  });

  it('valorParaCampo → texto editável com vírgula', () => {
    expect(valorParaCampo(1234.5)).toBe('1234,50');
    expect(valorParaCampo(null)).toBe('');
  });

  it('banco ↔ número', () => {
    expect(custoDoBanco('150.00')).toBe(150);
    expect(custoDoBanco(null)).toBeNull();
    expect(custoParaBanco(150.5)).toBe('150.50');
    expect(custoParaBanco(null)).toBeNull();
  });
});

describe('detalheEventoCusto — timeline', () => {
  it('estimativa: de/para com rótulos; null vira "sem estimativa"', () => {
    expect(detalheEventoCusto('estimativa_custo_alterada', { de: null, para: 'B' })).toBe(
      '(sem estimativa → B · R$ 100 a R$ 200)',
    );
    expect(detalheEventoCusto('estimativa_custo_alterada', { de: 'E', para: null })).toBe(
      '(E · acima de R$ 600 → sem estimativa)',
    );
  });

  it('custo final: valor, correção e remoção', () => {
    expect(detalheEventoCusto('custo_final_definido', { de: null, para: 150 })).toBe('(R$ 150,00)');
    expect(detalheEventoCusto('custo_final_definido', { de: 150, para: 180.5 })).toBe(
      '(R$ 150,00 → R$ 180,50)',
    );
    expect(detalheEventoCusto('custo_final_definido', { de: 150, para: null })).toBe(
      '(R$ 150,00 → removido)',
    );
  });

  it('outros eventos → null', () => {
    expect(detalheEventoCusto('prioridade_alterada', { de: 'baixa', para: 'alta' })).toBeNull();
  });
});
