/**
 * Utilitários de texto do domínio (puros). Comparação tolerante a acento e
 * caixa — o modelo escreve "alteração" ou "alteracao", "E2E" ou "e2e" — e a
 * similaridade por trigramas do pingue-pongue (specs/forja/03 §6).
 */

/** Minúsculas, sem acento (NFD sem marcas combinantes), espaços colapsados. */
export function normalizarComparacao(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Conjunto de trigramas no estilo do `pg_trgm`: cada palavra (sequência de
 * letras/dígitos) ganha dois espaços à esquerda e um à direita antes do
 * fatiamento. POR QUE esse estilo: é o "trigrama" que quem lê a spec conhece
 * (Postgres do Chamados) e dá peso às bordas das palavras, então uma frase
 * reescrita com as mesmas palavras em outra ordem continua parecida.
 */
export function trigramas(texto: string): Set<string> {
  const saida = new Set<string>();
  for (const palavra of normalizarComparacao(texto).split(/[^\p{L}\p{N}]+/u)) {
    if (!palavra) continue;
    const p = `  ${palavra} `;
    for (let i = 0; i + 3 <= p.length; i += 1) saida.add(p.slice(i, i + 3));
  }
  return saida;
}

/** Similaridade de Jaccard entre os conjuntos de trigramas (0..1; dois vazios = 1). */
export function similaridadeTrigramas(a: string, b: string): number {
  const ta = trigramas(a);
  const tb = trigramas(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let comum = 0;
  for (const t of ta) if (tb.has(t)) comum += 1;
  return comum / (ta.size + tb.size - comum);
}
