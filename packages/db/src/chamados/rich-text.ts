import { randomUUID, createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { enviarObjeto, chaveAnexo } from '@chamados/storage';
import type { DocRichText } from '../entities/chamado';
import { AnexoSchema } from '../entities/anexo';
import { auditorDe, type HooksChamado } from './auditoria';
import { detectarImagemInline, MAX_IMAGENS_INLINE } from './validacao-arquivo';

/**
 * Pipeline REAL de rich text (specs/04 §5, specs/09 §6). Substitui o utilitário
 * provisório de M3. Fluxo, na ordem exigida pela spec:
 *
 *  1. VALIDAÇÃO ESTRUTURAL: a entrada é um documento ProseMirror/TipTap. Só nós e
 *     marcas da allowlist sobrevivem; o resto é descartado (default-deny). O root
 *     precisa ser `{ type: 'doc' }`.
 *  2. PRÉ-PROCESSAMENTO de imagens coladas (`data:`) ANTES da sanitização: extrai
 *     cada imagem, valida por MAGIC BYTES, e (na fase 2) faz upload como `Anexo`
 *     (`inline=true`, prefixo por tenant) e reescreve o `src` para a referência do
 *     anexo (`/api/anexos/<id>`). Sem esse passo a sanitização descartaria o
 *     `data:` e a imagem colada sumiria.
 *  3. SANITIZAÇÃO: o HTML é CONSTRUÍDO a partir do JSON já validado (nunca
 *     parseando HTML do cliente) — só tags/atributos da allowlist, texto escapado,
 *     sem `data:`, sem `script`/handlers `on*`, sem `javascript:`. Links só
 *     `http(s)`/`mailto`, com `rel` seguro.
 *
 * Guardamos as DUAS representações (specs/02): `*_json` (fonte da verdade) e
 * `*_html` (render seguro). Aplica-se igual à descrição do chamado e às mensagens.
 */

// ---------------------------------------------------------------------------
// Tipos ricos do documento (recursivos — vivem SÓ aqui, fora das entidades)
// ---------------------------------------------------------------------------

export interface MarcaRichText {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface NoRichText {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NoRichText[];
  marks?: MarcaRichText[];
  text?: string;
}
export interface DocRico {
  type: 'doc';
  content?: NoRichText[];
}

/** Limite de texto renderizado do corpo (specs/04 §5). */
export const LIMITE_CORPO_MAX = 50_000;

/** Prefixo da referência interna de um anexo servido pela aplicação. */
export const PREFIXO_REF_ANEXO = '/api/anexos/';

export type MotivoRichText =
  'doc_invalido' | 'corpo_vazio' | 'corpo_muito_longo' | 'imagem_invalida' | 'imagens_demais';

// ---------------------------------------------------------------------------
// Allowlist de nós e marcas
// ---------------------------------------------------------------------------

/** Nós de bloco/inline permitidos e os atributos que cada um pode conservar. */
const ATRIBUTOS_NO: Record<string, readonly string[]> = {
  doc: [],
  paragraph: [],
  heading: ['level'],
  blockquote: [],
  codeBlock: ['language'],
  bulletList: [],
  orderedList: ['start'],
  listItem: [],
  horizontalRule: [],
  hardBreak: [],
  image: ['src', 'alt', 'title', 'data-anexo-id'],
  table: [],
  tableRow: [],
  tableHeader: ['colspan', 'rowspan'],
  tableCell: ['colspan', 'rowspan'],
  text: [],
};

/** Marcas de formatação permitidas. `link` tem tratamento de `href` seguro. */
const MARCAS_PERMITIDAS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

// ---------------------------------------------------------------------------
// Fase 1 — validação estrutural + extração de imagens coladas
// ---------------------------------------------------------------------------

export interface ImagemColada {
  /** Referência ao nó (no doc filtrado) cujo `src` será reescrito na fase 2. */
  no: NoRichText;
  buffer: Buffer;
  contentType: string;
  ext: string;
  checksum: string;
  tamanho: number;
}

export interface DocValidado {
  doc: DocRico;
  imagens: ImagemColada[];
  textoLength: number;
}

interface CtxValidacao {
  imagens: ImagemColada[];
  erro: MotivoRichText | null;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Decodifica um data URI (`data:[mime][;base64],dados`). `null` se malformado. */
function parseDataUri(src: string): Buffer | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(src);
  if (!m) return null;
  try {
    return m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
  } catch {
    return null;
  }
}

/** Uma marca sobrevive à allowlist? Normaliza `link` (href seguro obrigatório). */
function filtrarMarca(bruta: unknown): MarcaRichText | null {
  if (!ehObjeto(bruta) || typeof bruta.type !== 'string') return null;
  if (!MARCAS_PERMITIDAS.has(bruta.type)) return null;
  if (bruta.type === 'link') {
    const attrs = ehObjeto(bruta.attrs) ? bruta.attrs : {};
    const href = hrefSeguro(attrs.href);
    if (!href) return null; // link sem href seguro vira texto puro (marca descartada).
    return { type: 'link', attrs: { href } };
  }
  return { type: bruta.type };
}

/** `href` restrito a esquemas seguros (specs/09 §6). */
function hrefSeguro(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return null;
}

/** Copia só os atributos permitidos de um nó (com normalizações pontuais). */
function filtrarAtributos(tipo: string, attrs: unknown): Record<string, unknown> | undefined {
  const permitidos = ATRIBUTOS_NO[tipo];
  if (!permitidos || permitidos.length === 0 || !ehObjeto(attrs)) return undefined;
  const out: Record<string, unknown> = {};
  for (const chave of permitidos) {
    if (!(chave in attrs)) continue;
    let valor = attrs[chave];
    if (tipo === 'heading' && chave === 'level') {
      const n = Number(valor);
      valor = Number.isFinite(n) ? Math.min(3, Math.max(1, Math.trunc(n))) : 1;
    }
    if (valor !== undefined && valor !== null) out[chave] = valor;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Filtra recursivamente um nó bruto para a forma canônica (allowlist). Retorna
 * `null` para nós descartados (tipo desconhecido, imagem externa/ inválida).
 * Coleta imagens `data:` para materialização posterior.
 */
function filtrarNo(bruto: unknown, ctx: CtxValidacao): NoRichText | null {
  if (ctx.erro) return null;
  if (!ehObjeto(bruto) || typeof bruto.type !== 'string') return null;
  const tipo = bruto.type;
  if (!(tipo in ATRIBUTOS_NO)) return null; // nó fora da allowlist → descartado.

  // Nó de texto (folha).
  if (tipo === 'text') {
    if (typeof bruto.text !== 'string' || bruto.text.length === 0) return null;
    const marks = Array.isArray(bruto.marks)
      ? bruto.marks.map(filtrarMarca).filter((m): m is MarcaRichText => m !== null)
      : undefined;
    const no: NoRichText = { type: 'text', text: bruto.text };
    if (marks && marks.length > 0) no.marks = marks;
    return no;
  }

  const no: NoRichText = { type: tipo };
  const attrs = filtrarAtributos(tipo, bruto.attrs);
  if (attrs) no.attrs = attrs;

  // Imagem: só sobrevive se for data: (colada → vira anexo) ou já uma ref interna.
  if (tipo === 'image') {
    return tratarImagem(no, bruto, ctx);
  }

  if (Array.isArray(bruto.content)) {
    const filhos = bruto.content
      .map((f) => filtrarNo(f, ctx))
      .filter((f): f is NoRichText => f !== null);
    if (filhos.length > 0) no.content = filhos;
  }
  return no;
}

/** Regras da imagem: data: → extrai/valida; ref interna → mantém; resto → descarta. */
function tratarImagem(
  no: NoRichText,
  bruto: Record<string, unknown>,
  ctx: CtxValidacao,
): NoRichText | null {
  const attrs = ehObjeto(bruto.attrs) ? bruto.attrs : {};
  const src = typeof attrs.src === 'string' ? attrs.src : '';

  if (src.startsWith('data:')) {
    if (ctx.imagens.length >= MAX_IMAGENS_INLINE) {
      ctx.erro = 'imagens_demais';
      return null;
    }
    const buffer = parseDataUri(src);
    if (!buffer) {
      ctx.erro = 'imagem_invalida';
      return null;
    }
    const det = detectarImagemInline(buffer);
    if (!det.ok) {
      ctx.erro = 'imagem_invalida';
      return null;
    }
    // src placeholder; a fase 2 reescreve para /api/anexos/<id>.
    no.attrs = { ...(no.attrs ?? {}), src: '' };
    if (typeof attrs.alt === 'string') no.attrs.alt = attrs.alt;
    ctx.imagens.push({
      no,
      buffer,
      contentType: det.tipo.contentType,
      ext: det.tipo.ext,
      checksum: createHash('sha256').update(buffer).digest('hex'),
      tamanho: buffer.length,
    });
    return no;
  }

  // Referência interna já materializada (reedição): mantém.
  if (src.startsWith(PREFIXO_REF_ANEXO)) {
    no.attrs = { ...(no.attrs ?? {}), src };
    return no;
  }

  // Qualquer outra origem (http externo, javascript:, etc.) é descartada.
  return null;
}

/** Extrai o texto renderizado (para validar o limite de corpo — specs/04 §5). */
function extrairTexto(no: NoRichText): string {
  if (no.type === 'text') return no.text ?? '';
  if (no.type === 'hardBreak') return '\n';
  if (!no.content) return no.type === 'paragraph' || no.type === 'heading' ? '\n' : '';
  const filhos = no.content.map(extrairTexto).join('');
  const bloco = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(no.type);
  return bloco ? filhos + '\n' : filhos;
}

/**
 * Fase 1: valida a estrutura e extrai as imagens coladas. NÃO toca banco/storage.
 * Falha fecha (retorna motivo) sem efeitos colaterais — o serviço pode abortar
 * antes de qualquer INSERT.
 */
export function validarDocRico(
  bruto: unknown,
): { ok: true; validado: DocValidado } | { ok: false; motivo: MotivoRichText } {
  if (!ehObjeto(bruto) || bruto.type !== 'doc') return { ok: false, motivo: 'doc_invalido' };

  const ctx: CtxValidacao = { imagens: [], erro: null };
  const conteudo = Array.isArray(bruto.content)
    ? bruto.content.map((n) => filtrarNo(n, ctx)).filter((n): n is NoRichText => n !== null)
    : [];
  if (ctx.erro) return { ok: false, motivo: ctx.erro };

  const doc: DocRico = { type: 'doc', content: conteudo };
  const texto = conteudo.map(extrairTexto).join('').trim();
  if (texto.length === 0 && ctx.imagens.length === 0) return { ok: false, motivo: 'corpo_vazio' };
  if (texto.length > LIMITE_CORPO_MAX) return { ok: false, motivo: 'corpo_muito_longo' };

  return { ok: true, validado: { doc, imagens: ctx.imagens, textoLength: texto.length } };
}

// ---------------------------------------------------------------------------
// Fase 2 — materialização (upload dos anexos inline) + render do HTML sanitizado
// ---------------------------------------------------------------------------

export interface AlvoMaterializacao {
  em: EntityManager;
  tenantId: string;
  chamadoId: string;
  /** Quando a materialização é de uma MENSAGEM (senão é a descrição do chamado). */
  mensagemId?: string | null;
  atorId: string | null;
  validado: DocValidado;
  hooks?: HooksChamado;
}

export interface ResultadoMaterializacao {
  json: DocRichText;
  html: string;
  anexosInline: string[];
}

/**
 * Fase 2: para cada imagem colada cria um `Anexo` (`inline=true`, prefixo por
 * tenant), faz upload, reescreve o `src` do nó para `/api/anexos/<id>` e emite
 * `anexo_adicionado`. Depois RENDERIZA o HTML sanitizado a partir do JSON final
 * (que já não contém `data:`). Roda dentro da transação/tenant do chamado.
 */
export async function materializarDoc(alvo: AlvoMaterializacao): Promise<ResultadoMaterializacao> {
  const { em, tenantId, chamadoId, mensagemId, atorId, validado } = alvo;
  const auditar = auditorDe(alvo.hooks);
  const anexosInline: string[] = [];

  for (const img of validado.imagens) {
    const anexoId = randomUUID();
    const storageKey = chaveAnexo(tenantId, chamadoId, anexoId);
    await em.insert(AnexoSchema, {
      id: anexoId,
      tenant_id: tenantId,
      chamado_id: mensagemId ? null : chamadoId,
      mensagem_id: mensagemId ?? null,
      nome_arquivo: `imagem-colada.${img.ext}`,
      content_type: img.contentType,
      tamanho_bytes: String(img.tamanho),
      storage_key: storageKey,
      checksum_sha256: img.checksum,
      inline: true,
    });
    await enviarObjeto(storageKey, img.buffer, img.contentType);
    img.no.attrs = {
      ...(img.no.attrs ?? {}),
      src: `${PREFIXO_REF_ANEXO}${anexoId}`,
      'data-anexo-id': anexoId,
    };
    anexosInline.push(anexoId);
    await auditar(em, {
      tipo: 'anexo_adicionado',
      chamado_id: chamadoId,
      ator_id: atorId,
      dados: { anexo_id: anexoId, mensagem_id: mensagemId ?? null, inline: true },
    });
  }

  const html = renderizarHtml(validado.doc);
  return { json: validado.doc as unknown as DocRichText, html, anexosInline };
}

// ---------------------------------------------------------------------------
// Render de HTML sanitizado (construído a partir do JSON — nunca parse do cliente)
// ---------------------------------------------------------------------------

/** Escapa os 5 caracteres perigosos para interpolação segura em HTML. */
export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ABRE_MARCA: Record<string, (m: MarcaRichText) => string> = {
  bold: () => '<strong>',
  italic: () => '<em>',
  underline: () => '<u>',
  strike: () => '<s>',
  code: () => '<code>',
  link: (m) =>
    `<a href="${escaparHtml(String(m.attrs?.href ?? ''))}" rel="noopener noreferrer nofollow" target="_blank">`,
};
const FECHA_MARCA: Record<string, string> = {
  bold: '</strong>',
  italic: '</em>',
  underline: '</u>',
  strike: '</s>',
  code: '</code>',
  link: '</a>',
};

/** Renderiza um nó de texto com suas marcas aninhadas. */
function renderTexto(no: NoRichText): string {
  const texto = escaparHtml(no.text ?? '');
  const marcas = (no.marks ?? []).filter((m) => m.type in ABRE_MARCA);
  const abre = marcas.map((m) => ABRE_MARCA[m.type]!(m)).join('');
  const fecha = marcas
    .slice()
    .reverse()
    .map((m) => FECHA_MARCA[m.type]!)
    .join('');
  return abre + texto + fecha;
}

/** Renderiza o conteúdo (filhos) de um nó. */
function renderFilhos(no: NoRichText): string {
  return (no.content ?? []).map(renderNo).join('');
}

/** Renderiza um nó para HTML seguro (só tags da allowlist). */
function renderNo(no: NoRichText): string {
  switch (no.type) {
    case 'text':
      return renderTexto(no);
    case 'paragraph':
      return `<p>${renderFilhos(no)}</p>`;
    case 'heading': {
      const nivel = Math.min(3, Math.max(1, Number(no.attrs?.level ?? 1)));
      return `<h${nivel}>${renderFilhos(no)}</h${nivel}>`;
    }
    case 'blockquote':
      return `<blockquote>${renderFilhos(no)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${renderFilhos(no)}</code></pre>`;
    case 'bulletList':
      return `<ul>${renderFilhos(no)}</ul>`;
    case 'orderedList': {
      const start = Number(no.attrs?.start);
      const attr = Number.isFinite(start) && start > 1 ? ` start="${Math.trunc(start)}"` : '';
      return `<ol${attr}>${renderFilhos(no)}</ol>`;
    }
    case 'listItem':
      return `<li>${renderFilhos(no)}</li>`;
    case 'horizontalRule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'image': {
      const src = String(no.attrs?.src ?? '');
      // Segurança: só serve referência interna (data:/externo já foram removidos).
      if (!src.startsWith(PREFIXO_REF_ANEXO)) return '';
      const alt = escaparHtml(String(no.attrs?.alt ?? ''));
      return `<img src="${escaparHtml(src)}" alt="${alt}" loading="lazy">`;
    }
    case 'table':
      return `<table><tbody>${renderFilhos(no)}</tbody></table>`;
    case 'tableRow':
      return `<tr>${renderFilhos(no)}</tr>`;
    case 'tableHeader':
      return `<th>${renderFilhos(no)}</th>`;
    case 'tableCell':
      return `<td>${renderFilhos(no)}</td>`;
    default:
      return '';
  }
}

/** Renderiza o documento inteiro para HTML sanitizado. */
export function renderizarHtml(doc: DocRico): string {
  return (doc.content ?? []).map(renderNo).join('');
}

// ---------------------------------------------------------------------------
// Entrada por texto simples (editor provisório do M4 — o editor TipTap é M5)
// ---------------------------------------------------------------------------

/**
 * Converte texto simples num documento ProseMirror mínimo e válido: parágrafos
 * por linhas em branco, quebras simples viram `hardBreak`. O PIPELINE acima é o
 * mesmo, real e completo; só a ORIGEM do doc muda (textarea vs. editor rico).
 */
export function textoParaDoc(texto: string): DocRico {
  const paragrafos = texto
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragrafos.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };

  const content: NoRichText[] = paragrafos.map((p) => {
    const linhas = p.split('\n');
    const inline: NoRichText[] = [];
    linhas.forEach((linha, i) => {
      if (i > 0) inline.push({ type: 'hardBreak' });
      if (linha.length > 0) inline.push({ type: 'text', text: linha });
    });
    return { type: 'paragraph', content: inline };
  });
  return { type: 'doc', content };
}

/** Normaliza a entrada (texto simples OU doc já estruturado) num doc bruto. */
export function normalizarEntradaRich(entrada: string | DocRico | unknown): unknown {
  return typeof entrada === 'string' ? textoParaDoc(entrada) : entrada;
}

// ---------------------------------------------------------------------------
// Projeção textual (caminho INVERSO: HTML sanitizado → texto puro)
// ---------------------------------------------------------------------------

/**
 * Converte o HTML JÁ SANITIZADO numa projeção de texto puro. Usado onde o
 * consumidor não é um navegador: o contexto do modelo na triagem (specs/05 §4.1)
 * e a API `/api/v1` (specs/11 §1) — em ambos, HTML seria só ruído/tokens.
 *
 * Opera sobre o HTML que ESTE módulo produziu (allowlist, tags fechadas, texto
 * escapado), não sobre HTML arbitrário do cliente: é uma projeção de saída, nunca
 * uma barreira de segurança — a sanitização acontece na ESCRITA.
 */
export function htmlParaTexto(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
