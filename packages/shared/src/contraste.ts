/**
 * Contraste de cor WCAG 2.1 (specs/08 §6 e §7) — puro e testável, sem dependências.
 *
 * Usado para validar o branding do tenant no salvamento: um par texto/fundo
 * derivado das cores do tenant precisa atingir o mínimo AA (4.5:1 para texto
 * normal, 3:1 para texto grande). Se reprovar, a UI recusa/alerta e cai no
 * fallback neutro (specs/07 §3.2, specs/08 §7).
 */

/** Razão de contraste mínima AA para texto normal. */
export const AA_TEXTO_NORMAL = 4.5;
/** Razão de contraste mínima AA para texto grande (>= 18pt ou 14pt bold). */
export const AA_TEXTO_GRANDE = 3;

/** Preto quase puro usado como candidato a cor de texto sobre fundos claros. */
export const TEXTO_ESCURO = '#0a0a0a';
/** Branco quase puro usado como candidato a cor de texto sobre fundos escuros. */
export const TEXTO_CLARO = '#fafafa';
/** Fundo claro de referência da UI (`--background` do tema claro é branco). */
export const FUNDO_CLARO = '#ffffff';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Faz o parse de uma cor hex (`#rgb`, `#rrggbb`, com ou sem `#`). Retorna os
 * componentes 0–255 ou `null` se o formato for inválido.
 */
export function parseHex(hex: string): RGB | null {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (/^[0-9a-f]{3}$/.test(h)) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Uma string é uma cor hex válida (`#rgb`/`#rrggbb`)? */
export function corHexValida(hex: string): boolean {
  return parseHex(hex) !== null;
}

/** Normaliza para a forma `#rrggbb` minúscula; `null` se inválida. */
export function normalizarHex(hex: string): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const p = (n: number) => n.toString(16).padStart(2, '0');
  return `#${p(rgb.r)}${p(rgb.g)}${p(rgb.b)}`;
}

/** Converte um componente sRGB (0–255) para o espaço linear (WCAG). */
function canalLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Luminância relativa (0 = preto, 1 = branco) de uma cor hex. */
export function luminanciaRelativa(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Cor hex inválida: ${hex}`);
  return (
    0.2126 * canalLinear(rgb.r) +
    0.7152 * canalLinear(rgb.g) +
    0.0722 * canalLinear(rgb.b)
  );
}

/** Razão de contraste (1–21) entre duas cores hex. */
export function razaoContraste(corA: string, corB: string): number {
  const la = luminanciaRelativa(corA);
  const lb = luminanciaRelativa(corB);
  const claro = Math.max(la, lb);
  const escuro = Math.min(la, lb);
  return (claro + 0.05) / (escuro + 0.05);
}

/**
 * Escolhe a melhor cor de texto (escuro vs. claro) para um fundo, retornando a
 * cor e a razão de contraste obtida.
 */
export function melhorTexto(fundoHex: string): { cor: string; razao: number } {
  const comEscuro = razaoContraste(fundoHex, TEXTO_ESCURO);
  const comClaro = razaoContraste(fundoHex, TEXTO_CLARO);
  return comEscuro >= comClaro
    ? { cor: TEXTO_ESCURO, razao: comEscuro }
    : { cor: TEXTO_CLARO, razao: comClaro };
}

export interface ResultadoContraste {
  /** A cor atinge AA como texto/acento sobre o fundo claro da UI? */
  ok: boolean;
  /** Razão de contraste da cor da marca contra o fundo claro (branco). */
  razao: number;
  /** Melhor cor de texto (b/w) para usar SOBRE a cor (ex.: botão primário). */
  foreground: string;
  minimo: number;
}

/**
 * Avalia uma cor de marca (ex.: cor primária do tenant). O gate de contraste é a
 * legibilidade da cor como TEXTO/ACENTO (links, destaques) sobre o fundo claro da
 * UI — é onde uma cor pálida reprova (specs/08 §6/§7). Cores muito claras são
 * recusadas no salvamento. `foreground` é o melhor texto b/w para quando a cor é
 * usada como FUNDO (botão primário), pareamento sempre legível por construção.
 * `grande=false` usa o limiar de texto normal (4.5:1).
 */
export function avaliarCorMarca(cor: string, grande = false): ResultadoContraste {
  const minimo = grande ? AA_TEXTO_GRANDE : AA_TEXTO_NORMAL;
  if (!corHexValida(cor)) {
    return { ok: false, razao: 0, foreground: TEXTO_CLARO, minimo };
  }
  const razao = razaoContraste(cor, FUNDO_CLARO);
  const { cor: foreground } = melhorTexto(cor);
  return { ok: razao >= minimo, razao, foreground, minimo };
}
