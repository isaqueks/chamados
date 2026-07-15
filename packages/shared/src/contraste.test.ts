import { describe, it, expect } from 'vitest';
import {
  parseHex,
  corHexValida,
  normalizarHex,
  razaoContraste,
  luminanciaRelativa,
  melhorTexto,
  avaliarCorMarca,
  AA_TEXTO_NORMAL,
  TEXTO_CLARO,
  TEXTO_ESCURO,
} from './contraste';

describe('parseHex', () => {
  it('faz parse de #rrggbb', () => {
    expect(parseHex('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });
  it('faz parse de #rgb (curto)', () => {
    expect(parseHex('#f00')).toEqual({ r: 255, g: 0, b: 0 });
  });
  it('aceita sem # e maiúsculas', () => {
    expect(parseHex('FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('rejeita inválidos', () => {
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('roxo')).toBeNull();
    expect(parseHex('#gggggg')).toBeNull();
  });
});

describe('corHexValida / normalizarHex', () => {
  it('valida corretamente', () => {
    expect(corHexValida('#abc')).toBe(true);
    expect(corHexValida('#zzzzzz')).toBe(false);
  });
  it('normaliza para #rrggbb minúsculo', () => {
    expect(normalizarHex('#ABC')).toBe('#aabbcc');
    expect(normalizarHex('nope')).toBeNull();
  });
});

describe('razaoContraste', () => {
  it('preto vs branco = 21:1', () => {
    expect(razaoContraste('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  it('cor igual = 1:1', () => {
    expect(razaoContraste('#345678', '#345678')).toBeCloseTo(1, 5);
  });
  it('é simétrica', () => {
    expect(razaoContraste('#123456', '#abcdef')).toBeCloseTo(
      razaoContraste('#abcdef', '#123456'),
      6,
    );
  });
});

describe('luminanciaRelativa', () => {
  it('branco ~1 e preto 0', () => {
    expect(luminanciaRelativa('#ffffff')).toBeCloseTo(1, 5);
    expect(luminanciaRelativa('#000000')).toBeCloseTo(0, 5);
  });
});

describe('melhorTexto', () => {
  it('escolhe texto escuro sobre fundo claro', () => {
    expect(melhorTexto('#fde047').cor).toBe(TEXTO_ESCURO); // amarelo claro
  });
  it('escolhe texto claro sobre fundo escuro', () => {
    expect(melhorTexto('#1e293b').cor).toBe(TEXTO_CLARO); // azul escuro
  });
});

describe('avaliarCorMarca', () => {
  it('aprova azul escuro (contraste alto sobre fundo claro)', () => {
    const r = avaliarCorMarca('#1d4ed8');
    expect(r.ok).toBe(true);
    expect(r.razao).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL);
    // Cor escura o suficiente para levar texto claro quando usada como fundo.
    expect(r.foreground).toBe(TEXTO_CLARO);
  });
  it('reprova um cinza médio (contraste insuficiente sobre branco)', () => {
    const r = avaliarCorMarca('#808080');
    expect(r.ok).toBe(false);
  });
  it('reprova amarelo claro (ilegível como texto/acento sobre branco)', () => {
    const r = avaliarCorMarca('#facc15');
    expect(r.ok).toBe(false);
    // Ainda assim, o melhor texto SOBRE o amarelo (se fosse fundo) é o escuro.
    expect(r.foreground).toBe(TEXTO_ESCURO);
  });
  it('reprova cor inválida', () => {
    expect(avaliarCorMarca('não-é-cor').ok).toBe(false);
  });
});
