/**
 * Busca full-text de chamados (E-31, specs/04 §10.4). Interpreta o termo `q` da
 * fila/portal e devolve o MODO de busca a aplicar no query builder:
 *
 *  - `numero`  — o termo é um número de chamado (`#123` ou `123`) → LIKE por
 *    prefixo em `numero` (o operador quer o ticket, não uma palavra).
 *  - `fts`     — caso geral (≥ 3 chars com letras) → `websearch_to_tsquery`
 *    ('portuguese') sobre a coluna gerada `busca_tsv` (título peso A > corpo
 *    peso B), com ranking por `ts_rank`. `websearch_to_tsquery` é TOLERANTE a
 *    sintaxe (nunca lança), então não há erro a tratar — só o vazio, que
 *    naturalmente não casa nada.
 *  - `ilike`   — fallback para termos CURTOS (1–2 chars, que o FTS não indexa
 *    bem) → ILIKE no título.
 *  - `nenhum`  — termo vazio.
 *
 * A RLS já escopa o tenant em toda query; a busca só adiciona o predicado de
 * texto. Como `busca_tsv` cobre apenas título + descrição (ambos públicos), a
 * busca NUNCA vaza conteúdo de nota interna (specs/04 §10.4).
 */

/** Nº mínimo de caracteres para usar full-text (abaixo disso, ILIKE). */
export const FTS_MIN_CHARS = 3;

export type ModoBusca =
  | { modo: 'nenhum' }
  | { modo: 'numero'; numero: string }
  | { modo: 'ilike'; termo: string }
  | { modo: 'fts'; tsq: string };

/** Classifica o termo bruto em um modo de busca. */
export function interpretarBusca(bruto?: string): ModoBusca {
  const q = (bruto ?? '').trim();
  if (q === '') return { modo: 'nenhum' };

  // Número de chamado: "#123" ou "123" → prefixo em `numero`.
  const soDigitos = q.replace(/^#/, '');
  if (/^\d+$/.test(soDigitos)) return { modo: 'numero', numero: soDigitos };

  // Termo curto → ILIKE (FTS com stemming não ajuda em 1–2 chars).
  if (q.length < FTS_MIN_CHARS) return { modo: 'ilike', termo: q };

  // Caso geral → full-text.
  return { modo: 'fts', tsq: q };
}

/** Predicado SQL `busca_tsv @@ websearch_to_tsquery(...)` para o alias e param dados. */
export function exprMatchFts(alias: string, param: string): string {
  return `"${alias}"."busca_tsv" @@ websearch_to_tsquery('portuguese', :${param})`;
}

/** Expressão de ranking `ts_rank(...)` para o alias e param dados. */
export function exprRankFts(alias: string, param: string): string {
  return `ts_rank("${alias}"."busca_tsv", websearch_to_tsquery('portuguese', :${param}))`;
}
