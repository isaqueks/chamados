import type { DocRichText, BlocoDoc, NoInlineDoc } from '../entities/chamado';

/**
 * ⚠️ PROVISÓRIO (M3) — SUBSTITUIR EM M4.
 *
 * O pipeline real de rich text (TipTap → extração de imagens coladas → upload
 * como Anexo → sanitização server-side com allowlist) é escopo de M4
 * (specs/04 §5, specs/09 §6). Aqui, em M3, o Chamado só aceita a descrição como
 * TEXTO SIMPLES e a materializa de forma consistente nas DUAS colunas exigidas
 * pelo modelo (specs/02 "Armazenamento de rich text"):
 *   - `descricao_json`: documento ProseMirror/TipTap MÍNIMO e válido;
 *   - `descricao_html`: HTML ESCAPADO (nunca HTML bruto do cliente).
 *
 * M4 troca esta função pelo pipeline real, sem mudar o schema.
 */

/** Escapa os 5 caracteres perigosos para interpolação segura em HTML. */
function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Quebra o texto em parágrafos (linhas em branco) preservando quebras simples. */
function emParagrafos(texto: string): string[] {
  return texto
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Comprimento do texto renderizado (para validar o limite de corpo — specs/04 §5). */
export function comprimentoTextoDescricao(texto: string): number {
  return texto.trim().length;
}

/**
 * Converte texto simples nas duas representações do modelo. Parágrafos vêm de
 * linhas em branco; quebras simples viram `<br>` / hard_break. Um texto vazio
 * gera um doc mínimo válido (parágrafo vazio) — a validação de "descrição
 * obrigatória" é feita ANTES, na camada de serviço.
 */
export function textoParaDescricao(texto: string): {
  json: DocRichText;
  html: string;
} {
  const paragrafos = emParagrafos(texto);

  if (paragrafos.length === 0) {
    return { json: { type: 'doc', content: [{ type: 'paragraph' }] }, html: '<p></p>' };
  }

  const content: BlocoDoc[] = paragrafos.map((p) => {
    const linhas = p.split('\n');
    const inline: NoInlineDoc[] = [];
    linhas.forEach((linha, i) => {
      if (i > 0) inline.push({ type: 'hardBreak' });
      if (linha.length > 0) inline.push({ type: 'text', text: linha });
    });
    return { type: 'paragraph', content: inline };
  });

  const html = paragrafos
    .map((p) => `<p>${p.split('\n').map(escaparHtml).join('<br>')}</p>`)
    .join('');

  return { json: { type: 'doc', content }, html };
}
