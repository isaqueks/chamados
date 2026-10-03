import { createHash } from 'node:crypto';

/**
 * Normalização de corpo para comparar o que a Forja ENVIOU com o que a API
 * DEVOLVE (specs/forja/07 §9; 03 §9.2; critica X-4).
 *
 * POR QUE: o corpo volta do servidor convertido markdown → rich text →
 * markdown, então não casa byte a byte com o enviado. Antes de comparar
 * (marcador `[forja:…]` na nota interna, corpo da pública), os dois lados passam
 * por: forma NFC; remoção dos escapes `\` do markdown; ênfase unificada em `*`
 * (o servidor devolve `_itálico_` como `*itálico*` e `__negrito__` como
 * `**negrito**` — visto no spike S7.7); espaços colapsados; aparas. A troca
 * `_`→`*` vale para QUALQUER `_` (snake_case inclusive): como os dois lados
 * passam pela mesma função, a igualdade continua correta. O plano B (autor +
 * janela + primeiros 200 caracteres normalizados) está em `outbox-passos.ts`.
 */

/** Tamanho do prefixo do plano B de 07 §9. */
export const PREFIXO_COMPARACAO = 200;

export function normalizarCorpo(texto: string): string {
  return (texto ?? '')
    .normalize('NFC')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
    .replace(/_/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `corpo_hash` do outbox (02 §4.13): sha256 hex do corpo NORMALIZADO. */
export function hashCorpo(texto: string): string {
  return createHash('sha256').update(normalizarCorpo(texto), 'utf8').digest('hex');
}

/** Primeira linha não vazia, sem marcas de bloco markdown (`#`, `>`, `*`, `_`) e sem escapes. */
export function primeiraLinha(texto: string): string {
  for (const bruta of (texto ?? '').split(/\r?\n/)) {
    const linha = limparMarcasLinha(bruta);
    if (linha.length > 0) return linha;
  }
  return '';
}

/** Tira marcas de bloco/ênfase do markdown de UMA linha e normaliza. */
export function limparMarcasLinha(linha: string): string {
  return normalizarCorpo(
    linha
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+)?/, '')
      .replace(/^(?:\*\*|__|\*|_)+/, '')
      .replace(/(?:\*\*|__|\*|_)+\s*$/, ''),
  );
}
