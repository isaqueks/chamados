import PDFDocument from 'pdfkit';
import { marked, type Token, type Tokens } from 'marked';

/**
 * Gerador de PDF de ARTEFATOS entregáveis (D-026): renderiza markdown num PDF
 * paginado usando o LEXER do marked (o mesmo padrão de `markdownParaDoc` — nunca
 * o renderer HTML) + pdfkit com as fontes standard (Helvetica/Courier, métricas
 * embutidas — nenhum binário externo tipo chromium). Cobre títulos, parágrafos
 * (negrito/itálico/código/links), listas (aninhadas), tabelas GFM, blocos de
 * código, blockquote e hr — o suficiente para relatórios ao cliente.
 *
 * As fontes standard são WinAnsi (latin1): acentos pt-BR passam intactos;
 * pontuação tipográfica é normalizada e o restante fora do latin1 é descartado
 * (nunca lança por causa de um caractere).
 */

const MARGEM = 50;
const TAM_TEXTO = 10;
const TAM_TITULOS = [16, 13, 11.5] as const; // h1..h3 (h4+ clampa em h3)

/** Normaliza para WinAnsi: pontuação tipográfica → ASCII; resto fora do latin1 cai. */
function paraWinAnsi(texto: string): string {
  return (
    texto
      .replace(/[‘’‚]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/[•●▪]/g, '*')
      .replace(/\u00a0/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '')
  );
}

/** Um trecho inline com estilo resolvido (fonte/cor/link). */
interface Trecho {
  texto: string;
  negrito: boolean;
  italico: boolean;
  codigo: boolean;
  href?: string;
}

function desescapar(texto: string): string {
  return texto
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Achata tokens inline do marked em trechos estilizados. */
function trechosDe(
  tokens: Token[] | undefined,
  estilo: { negrito?: boolean; italico?: boolean; href?: string } = {},
): Trecho[] {
  const out: Trecho[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text': {
        const tk = t as Tokens.Text;
        if (tk.tokens && tk.tokens.length > 0) out.push(...trechosDe(tk.tokens, estilo));
        else out.push(trecho(desescapar(tk.text), estilo));
        break;
      }
      case 'escape':
        out.push(trecho(desescapar((t as Tokens.Escape).text), estilo));
        break;
      case 'strong':
        out.push(...trechosDe((t as Tokens.Strong).tokens, { ...estilo, negrito: true }));
        break;
      case 'em':
        out.push(...trechosDe((t as Tokens.Em).tokens, { ...estilo, italico: true }));
        break;
      case 'del':
        out.push(...trechosDe((t as Tokens.Del).tokens, estilo));
        break;
      case 'codespan':
        out.push({ ...trecho(desescapar((t as Tokens.Codespan).text), estilo), codigo: true });
        break;
      case 'link': {
        const lk = t as Tokens.Link;
        out.push(...trechosDe(lk.tokens, { ...estilo, href: lk.href }));
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        out.push(trecho(desescapar(img.text || img.href), estilo));
        break;
      }
      case 'br':
        out.push(trecho('\n', estilo));
        break;
      default: {
        const cru = 'raw' in t && typeof t.raw === 'string' ? t.raw : '';
        if (cru) out.push(trecho(cru, estilo));
      }
    }
  }
  return out;
}

function trecho(
  texto: string,
  estilo: { negrito?: boolean; italico?: boolean; href?: string },
): Trecho {
  return {
    texto: paraWinAnsi(texto),
    negrito: estilo.negrito === true,
    italico: estilo.italico === true,
    codigo: false,
    href: estilo.href,
  };
}

function fonteDe(t: Trecho): string {
  if (t.codigo) return 'Courier';
  if (t.negrito && t.italico) return 'Helvetica-BoldOblique';
  if (t.negrito) return 'Helvetica-Bold';
  if (t.italico) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Texto plano de uma sequência de trechos (para células de tabela/medições). */
function textoPlano(trechos: Trecho[]): string {
  return trechos.map((t) => t.texto).join('');
}

type Doc = InstanceType<typeof PDFDocument>;

function larguraUtil(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Escreve trechos estilizados como um parágrafo contínuo (com wrap do pdfkit). */
function escreverTrechos(doc: Doc, trechos: Trecho[], opts: { indent?: number } = {}): void {
  const uteis = trechos.filter((t) => t.texto.length > 0);
  if (uteis.length === 0) {
    doc.moveDown(0.5);
    return;
  }
  const indent = opts.indent ?? 0;
  const largura = larguraUtil(doc) - indent;
  const x = doc.page.margins.left + indent;
  for (let i = 0; i < uteis.length; i++) {
    const t = uteis[i]!;
    doc
      .font(fonteDe(t))
      .fontSize(TAM_TEXTO)
      .fillColor(t.href ? '#1d4ed8' : '#111111');
    const continuar = i < uteis.length - 1;
    if (i === 0) {
      doc.text(t.texto, x, doc.y, {
        width: largura,
        continued: continuar,
        ...(t.href ? { link: t.href, underline: true } : {}),
      });
    } else {
      doc.text(t.texto, {
        width: largura,
        continued: continuar,
        ...(t.href ? { link: t.href, underline: true } : { link: undefined, underline: false }),
      });
    }
  }
  doc.fillColor('#111111');
  doc.moveDown(0.5);
}

/** Quebra de página preventiva quando não cabe `altura` na página atual. */
function garantirEspaco(doc: Doc, altura: number): void {
  const limite = doc.page.height - doc.page.margins.bottom;
  if (doc.y + altura > limite) doc.addPage();
}

function renderizarTabela(doc: Doc, tb: Tokens.Table): void {
  const nCols = tb.header.length;
  if (nCols === 0) return;
  const largura = larguraUtil(doc);
  const colW = largura / nCols;
  const padding = 4;

  const linhaCells = (cells: Array<{ tokens?: Token[] }>): string[] =>
    cells.map((c) => paraWinAnsi(textoPlano(trechosDe(c.tokens))));

  const desenharLinha = (celulas: string[], negrito: boolean): void => {
    doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(TAM_TEXTO - 0.5);
    const alturas = celulas.map(
      (c) => doc.heightOfString(c || ' ', { width: colW - padding * 2 }) + padding * 2,
    );
    const alturaLinha = Math.max(...alturas, TAM_TEXTO + padding * 2);
    garantirEspaco(doc, alturaLinha);
    const y = doc.y;
    const x0 = doc.page.margins.left;
    for (let i = 0; i < celulas.length; i++) {
      const x = x0 + i * colW;
      doc.lineWidth(0.5).strokeColor('#bbbbbb').rect(x, y, colW, alturaLinha).stroke();
      doc
        .fillColor('#111111')
        .text(celulas[i] || ' ', x + padding, y + padding, { width: colW - padding * 2 });
    }
    doc.x = doc.page.margins.left;
    doc.y = y + alturaLinha;
  };

  desenharLinha(linhaCells(tb.header), true);
  for (const row of tb.rows) desenharLinha(linhaCells(row), false);
  doc.moveDown(0.5);
}

function renderizarLista(doc: Doc, lista: Tokens.List, nivel: number): void {
  const indent = nivel * 16;
  lista.items.forEach((item, idx) => {
    const marcador = lista.ordered
      ? `${(typeof lista.start === 'number' && lista.start > 1 ? lista.start : 1) + idx}. `
      : '- ';
    // Separa sub-listas (renderizadas recursivamente) do conteúdo inline do item.
    const blocos = item.tokens.filter((t) => t.type !== 'checkbox');
    const sublistas = blocos.filter((t): t is Tokens.List => t.type === 'list');
    const inlineTokens: Token[] = [];
    for (const b of blocos) {
      if (b.type === 'list') continue;
      if ((b.type === 'text' || b.type === 'paragraph') && 'tokens' in b) {
        inlineTokens.push(...((b as Tokens.Text).tokens ?? [b]));
      } else {
        inlineTokens.push(b);
      }
    }
    const prefixo = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
    const trechos = [trecho(marcador + prefixo, { negrito: false }), ...trechosDe(inlineTokens)];
    garantirEspaco(doc, TAM_TEXTO * 2);
    escreverTrechos(doc, trechos, { indent });
    doc.moveDown(-0.3); // itens de lista mais compactos que parágrafos
    for (const sub of sublistas) renderizarLista(doc, sub, nivel + 1);
  });
  doc.moveDown(0.5);
}

function renderizarBlocos(doc: Doc, tokens: Token[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        const tam = TAM_TITULOS[Math.min(h.depth, 3) - 1]!;
        garantirEspaco(doc, tam * 3);
        doc.moveDown(0.4);
        doc
          .font('Helvetica-Bold')
          .fontSize(tam)
          .fillColor('#111111')
          .text(paraWinAnsi(textoPlano(trechosDe(h.tokens))), doc.page.margins.left, doc.y, {
            width: larguraUtil(doc),
          });
        doc.moveDown(0.4);
        break;
      }
      case 'paragraph':
        escreverTrechos(doc, trechosDe((t as Tokens.Paragraph).tokens));
        break;
      case 'code': {
        const c = t as Tokens.Code;
        doc
          .font('Courier')
          .fontSize(TAM_TEXTO - 1)
          .fillColor('#333333');
        doc.text(paraWinAnsi(c.text), doc.page.margins.left + 12, doc.y, {
          width: larguraUtil(doc) - 12,
        });
        doc.fillColor('#111111').moveDown(0.5);
        break;
      }
      case 'blockquote': {
        doc.fillColor('#555555');
        renderizarBlocos(doc, (t as Tokens.Blockquote).tokens);
        doc.fillColor('#111111');
        break;
      }
      case 'list':
        renderizarLista(doc, t as Tokens.List, 0);
        break;
      case 'table':
        renderizarTabela(doc, t as Tokens.Table);
        break;
      case 'hr': {
        garantirEspaco(doc, 16);
        const y = doc.y + 4;
        doc
          .lineWidth(0.5)
          .strokeColor('#bbbbbb')
          .moveTo(doc.page.margins.left, y)
          .lineTo(doc.page.width - doc.page.margins.right, y)
          .stroke();
        doc.y = y + 8;
        break;
      }
      case 'html': {
        const texto = paraWinAnsi((t as Tokens.HTML).raw.trim());
        if (texto) escreverTrechos(doc, [trecho(texto, {})]);
        break;
      }
      case 'text':
        escreverTrechos(doc, trechosDe((t as Tokens.Text).tokens ?? [t]));
        break;
      default: {
        const cru = 'raw' in t && typeof t.raw === 'string' ? t.raw.trim() : '';
        if (cru) escreverTrechos(doc, [trecho(cru, {})]);
      }
    }
  }
}

/**
 * Renderiza `markdown` num PDF (A4) e devolve o buffer completo. `titulo`, quando
 * presente, vira o cabeçalho do documento. Lança `pdf_falhou:<motivo>` em erro.
 */
export async function gerarPdfDeMarkdown(titulo: string | null, markdown: string): Promise<Buffer> {
  try {
    const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGEM, bottom: MARGEM, left: MARGEM, right: MARGEM },
      info: titulo ? { Title: paraWinAnsi(titulo) } : {},
    });
    const partes: Buffer[] = [];
    const pronto = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c: Buffer) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);
    });

    if (titulo && titulo.trim().length > 0) {
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111');
      doc.text(paraWinAnsi(titulo.trim()), { width: larguraUtil(doc) });
      const y = doc.y + 6;
      doc
        .lineWidth(1)
        .strokeColor('#333333')
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .stroke();
      doc.y = y + 14;
    }

    renderizarBlocos(doc, tokens);
    doc.end();
    return await pronto;
  } catch (err) {
    throw new Error(`pdf_falhou:${(err as Error).message}`);
  }
}
