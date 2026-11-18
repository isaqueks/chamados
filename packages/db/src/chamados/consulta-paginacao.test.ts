import { describe, it, expect } from 'vitest';
import { normalizarPaginacaoFila, dataIsoValida, OFFSET_MAX_FILA } from './consulta-service';

/**
 * Paginação por offset LIMITADO da fila (D-045) — a parte pura. O recorte, a
 * ordenação e o RLS são provados no `smoke:chamados` §12 (precisa de Postgres).
 */
describe('normalizarPaginacaoFila', () => {
  it('padrões: página 1, 25 por página', () => {
    expect(normalizarPaginacaoFila(undefined, undefined)).toEqual({
      pagina: 1,
      limite: 25,
      offset: 0,
    });
  });

  it('limite entre 1 e 100; página mínima 1; valores não inteiros truncados', () => {
    expect(normalizarPaginacaoFila(3, 50)).toEqual({ pagina: 3, limite: 50, offset: 100 });
    expect(normalizarPaginacaoFila(0, 1000).limite).toBe(100);
    expect(normalizarPaginacaoFila(-5, 0)).toEqual({ pagina: 1, limite: 25, offset: 0 });
    expect(normalizarPaginacaoFila(2.9, 10.5)).toEqual({ pagina: 2, limite: 10, offset: 10 });
    expect(normalizarPaginacaoFila(Number.NaN, Number.NaN)).toEqual({
      pagina: 1,
      limite: 25,
      offset: 0,
    });
  });

  it(`o offset nunca passa de ${OFFSET_MAX_FILA}`, () => {
    const r = normalizarPaginacaoFila(1_000_000, 100);
    expect(r.offset).toBeLessThanOrEqual(OFFSET_MAX_FILA);
    expect(r.pagina).toBe(OFFSET_MAX_FILA / 100 + 1);
    expect(normalizarPaginacaoFila(1_000_000, 25).offset).toBeLessThanOrEqual(OFFSET_MAX_FILA);
  });
});

describe('dataIsoValida', () => {
  it('só AAAA-MM-DD existente no calendário', () => {
    expect(dataIsoValida('2026-11-17')).toBe(true);
    expect(dataIsoValida('2026-13-01')).toBe(false);
    expect(dataIsoValida('2026-02-29')).toBe(false);
    expect(dataIsoValida("2026-11-17'; DROP TABLE chamado;--")).toBe(false);
    expect(dataIsoValida(undefined)).toBe(false);
  });
});
