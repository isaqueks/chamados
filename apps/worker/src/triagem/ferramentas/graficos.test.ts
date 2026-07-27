import { describe, it, expect } from 'vitest';
import { validarGrafico, alturaGrafico, MAX_FATIAS, MAX_PONTOS } from './graficos';
import { misturar, paletaGrafico } from './cores';

/**
 * Gráficos vetoriais dos PDFs de artefato (D-027): validação da spec do bloco
 * ```grafico e aritmética de cor da paleta. O DESENHO em si é coberto pelos
 * testes de pdf.test.ts (PDF real gerado com os três tipos).
 */

describe('validarGrafico', () => {
  it('aceita e normaliza uma spec válida', () => {
    const spec = validarGrafico(
      JSON.stringify({
        tipo: 'barras',
        titulo: '  Chamados por mês  ',
        dados: [
          { rotulo: ' Jan ', valor: 12 },
          { rotulo: 'Fev', valor: 8.5 },
        ],
      }),
    );
    expect(spec.tipo).toBe('barras');
    expect(spec.titulo).toBe('Chamados por mês');
    expect(spec.dados).toEqual([
      { rotulo: 'Jan', valor: 12 },
      { rotulo: 'Fev', valor: 8.5 },
    ]);
  });

  it('titulo é opcional', () => {
    const spec = validarGrafico(
      JSON.stringify({ tipo: 'pizza', dados: [{ rotulo: 'A', valor: 1 }] }),
    );
    expect(spec.titulo).toBeNull();
  });

  it('rejeita JSON malformado com a forma esperada no erro', () => {
    expect(() => validarGrafico('{tipo:')).toThrow(/grafico_invalido: JSON malformado/);
    expect(() => validarGrafico('{tipo:')).toThrow(/forma esperada/);
  });

  it('rejeita tipo desconhecido, dados vazios e valores inválidos', () => {
    expect(() => validarGrafico(JSON.stringify({ tipo: 'radar', dados: [] }))).toThrow(
      /tipo deve ser um de barras\|linhas\|pizza/,
    );
    expect(() => validarGrafico(JSON.stringify({ tipo: 'barras', dados: [] }))).toThrow(
      /lista não vazia/,
    );
    expect(() =>
      validarGrafico(JSON.stringify({ tipo: 'barras', dados: [{ rotulo: 'A', valor: 'x' }] })),
    ).toThrow(/valor deve ser um número/);
    expect(() =>
      validarGrafico(JSON.stringify({ tipo: 'barras', dados: [{ rotulo: 'A', valor: -1 }] })),
    ).toThrow(/negativo/);
    expect(() =>
      validarGrafico(JSON.stringify({ tipo: 'barras', dados: [{ rotulo: '', valor: 1 }] })),
    ).toThrow(/rotulo/);
  });

  it('impõe os tetos de itens (pizza agrega em "Outros")', () => {
    const muitos = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ rotulo: `c${i}`, valor: i + 1 }));
    expect(() =>
      validarGrafico(JSON.stringify({ tipo: 'pizza', dados: muitos(MAX_FATIAS + 1) })),
    ).toThrow(/Outros/);
    expect(() =>
      validarGrafico(JSON.stringify({ tipo: 'linhas', dados: muitos(MAX_PONTOS + 1) })),
    ).toThrow(/no máximo/);
    expect(
      validarGrafico(JSON.stringify({ tipo: 'linhas', dados: muitos(MAX_PONTOS) })).dados,
    ).toHaveLength(MAX_PONTOS);
  });

  it('rejeita pizza toda zerada', () => {
    expect(() =>
      validarGrafico(
        JSON.stringify({
          tipo: 'pizza',
          dados: [
            { rotulo: 'A', valor: 0 },
            { rotulo: 'B', valor: 0 },
          ],
        }),
      ),
    ).toThrow(/valor > 0/);
  });

  it('alturaGrafico reserva espaço plausível numa página A4', () => {
    const barras = validarGrafico(
      JSON.stringify({ tipo: 'barras', titulo: 'T', dados: [{ rotulo: 'A', valor: 1 }] }),
    );
    const pizza = validarGrafico(
      JSON.stringify({
        tipo: 'pizza',
        dados: Array.from({ length: 8 }, (_, i) => ({ rotulo: `c${i}`, valor: 1 })),
      }),
    );
    // Cabe com folga no miolo de uma A4 (~740pt úteis), mas não é trivialmente pequeno.
    for (const spec of [barras, pizza]) {
      expect(alturaGrafico(spec)).toBeGreaterThan(100);
      expect(alturaGrafico(spec)).toBeLessThan(400);
    }
  });
});

describe('cores (mistura e paleta da marca)', () => {
  it('misturar interpola no RGB', () => {
    expect(misturar('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(misturar('#ff0000', '#ff0000', 0.9)).toBe('#ff0000');
    expect(misturar('#000000', '#ffffff', 0)).toBe('#000000');
    expect(misturar('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('misturar lança em hex inválida', () => {
    expect(() => misturar('azul', '#fff', 0.5)).toThrow(/cor inválida/);
  });

  it('paleta ancora na cor da marca, sem repetir cores adjacentes', () => {
    const paleta = paletaGrafico('#155e75', 8);
    expect(paleta[0]).toBe('#155e75');
    expect(paleta).toHaveLength(8);
    for (let i = 1; i < paleta.length; i++) expect(paleta[i]).not.toBe(paleta[i - 1]);
  });

  it('paleta maior que as variantes cicla', () => {
    expect(paletaGrafico('#155e75', 12)).toHaveLength(12);
  });
});
