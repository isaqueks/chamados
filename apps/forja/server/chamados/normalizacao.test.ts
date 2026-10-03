import { describe, expect, it } from 'vitest';
import { hashCorpo, normalizarCorpo, primeiraLinha } from './normalizacao';

/**
 * A comparação "enviado × devolvido" (07 §9) só funciona se os dois lados caem
 * na MESMA forma normalizada. Os casos vêm do que o servidor do Chamados fez de
 * fato no spike S7 (markdown → rich text → markdown).
 */
describe('normalizarCorpo', () => {
  it('remove escapes do markdown e colapsa espaços', () => {
    expect(normalizarCorpo('Olá\\!  Tudo\n\nbem \\(sim\\)')).toBe('Olá! Tudo bem (sim)');
  });

  it('iguala `_itálico_` enviado a `*itálico*` devolvido (S7.7)', () => {
    expect(normalizarCorpo('Clique em _Gerar segunda via_ no menu')).toBe(
      normalizarCorpo('Clique em *Gerar segunda via* no menu'),
    );
  });

  it('iguala `__negrito__` a `**negrito**` também no hash', () => {
    expect(hashCorpo('Prazo: __3 dias__')).toBe(hashCorpo('Prazo: **3 dias**'));
  });

  it('continua distinguindo textos realmente diferentes', () => {
    expect(hashCorpo('Prazo: 3 dias')).not.toBe(hashCorpo('Prazo: 5 dias'));
  });
});

describe('primeiraLinha', () => {
  it('ignora linhas vazias e tira marcas de bloco/ênfase', () => {
    expect(primeiraLinha('\n\n## **Resumo**\ncorpo')).toBe('Resumo');
  });
});
