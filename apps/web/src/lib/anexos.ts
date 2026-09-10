/**
 * Cabeçalhos seguros para servir um Anexo (specs/09 §5), compartilhados pela
 * rota de cookie (`/api/anexos/[id]`, redirect assinado) e pela rota Bearer da
 * API (`/api/v1/anexos/[id]`, streaming). Sem `server-only` de propósito: é
 * lógica pura de string, testável.
 */

/** Sanitiza o nome de arquivo para o header `Content-Disposition` (ASCII seguro). */
export function nomeAscii(nome: string): string {
  // Remove aspas/controles/barras e limita o tamanho — evita quebra de header.
  return (
    nome
      .replace(/[\r\n"\\/]+/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 200) || 'arquivo'
  );
}

/**
 * Monta um `Content-Disposition` seguro. Imagens inline do rich text são exibidas
 * (`inline`); qualquer outro anexo é forçado a DOWNLOAD (`attachment`) — nunca
 * renderizado no contexto da aplicação. `filename*` (RFC 5987) preserva o nome
 * original em UTF-8; `filename` ASCII é o fallback.
 */
export function contentDisposition(nome: string, inline: boolean): string {
  const tipo = inline ? 'inline' : 'attachment';
  const ascii = nomeAscii(nome);
  const utf8 = encodeURIComponent(nome).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16),
  );
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
