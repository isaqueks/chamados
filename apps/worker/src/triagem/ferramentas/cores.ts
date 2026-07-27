import { parseHex } from '@chamados/shared';

/**
 * Aritmética de cor para o template de PDF (D-027): tints/shades derivados da
 * cor primária do tenant — zebra de tabela, bordas e a paleta dos gráficos saem
 * TODAS da cor da marca (whitelabel de verdade, nunca uma paleta fixa alheia).
 */

/** Interpola linearmente `corA` → `corB` (t=0 → A, t=1 → B). Hexes inválidos lançam. */
export function misturar(corA: string, corB: string, t: number): string {
  const a = parseHex(corA);
  const b = parseHex(corB);
  if (!a || !b) throw new Error(`cor inválida na mistura: ${corA} / ${corB}`);
  const f = Math.max(0, Math.min(1, t));
  const canal = (x: number, y: number) => Math.round(x + (y - x) * f);
  const p = (n: number) => n.toString(16).padStart(2, '0');
  return `#${p(canal(a.r, b.r))}${p(canal(a.g, b.g))}${p(canal(a.b, b.b))}`;
}

/**
 * Paleta de `n` cores ancorada na cor da marca: variações claro/escuro alternadas
 * (fatias/séries adjacentes sempre distinguíveis) com um neutro de respiro.
 */
export function paletaGrafico(cor: string, n: number): string[] {
  const variantes = [
    cor,
    misturar(cor, '#ffffff', 0.45),
    misturar(cor, '#000000', 0.35),
    misturar(cor, '#ffffff', 0.68),
    misturar(cor, '#000000', 0.6),
    misturar(cor, '#ffffff', 0.25),
    '#94a3b8',
    misturar('#94a3b8', '#000000', 0.4),
  ];
  return Array.from({ length: Math.max(0, n) }, (_, i) => variantes[i % variantes.length]!);
}
