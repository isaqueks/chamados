import PDFDocument from 'pdfkit';
import { marked, type Token, type Tokens } from 'marked';
import { melhorTexto } from '@chamados/shared';
import { misturar, paletaGrafico } from './cores';
import { alturaGrafico, renderizarGrafico, validarGrafico, MAX_FATIAS } from './graficos';

/**
 * Gerador de PDF de ARTEFATOS entregáveis (D-026, template D-027): renderiza
 * markdown num PDF paginado usando o LEXER do marked (o mesmo padrão de
 * `markdownParaDoc` — nunca o renderer HTML) + pdfkit com as fontes standard
 * (Helvetica/Courier, métricas embutidas — nenhum binário externo tipo chromium).
 *
 * D-027 — template profissional NEUTRO (decisão do usuário: sem branding de
 * tenant no PDF): capa com faixa colorida (título + data), títulos e links em
 * cor, tabelas com cabeçalho colorido e zebra, blocos de código com fundo,
 * rodapé paginado — e GRÁFICOS vetoriais (bloco ```grafico, ver graficos.ts).
 * A paleta é sempre a padrão do produto (azul-petróleo — D-019).
 *
 * As fontes standard são WinAnsi (latin1): acentos pt-BR passam intactos;
 * pontuação tipográfica é normalizada e o restante fora do latin1 é descartado
 * (nunca lança por causa de um caractere).
 */

const MARGEM = 50;
const TAM_TEXTO = 10;
const TAM_TITULOS = [16, 13, 11.5] as const; // h1..h3 (h4+ clampa em h3)

/** Aproximação hex do azul-petróleo padrão do produto (`--primary`, D-019). */
const COR_PADRAO = '#155e75';

/** Cores do template — fixas na paleta padrão (D-027: sem branding no PDF). */
interface Tema {
  /** Cor de destaque (faixa da capa, cabeçalho de tabela, gráficos). */
  cor: string;
  /** Texto sobre a cor de destaque (preto/branco por contraste WCAG). */
  corTexto: string;
  /** Cor de títulos/links sobre fundo branco. */
  corTitulo: string;
  /** Tint suave para zebra de tabela. */
  zebra: string;
  /** Tint para bordas/réguas discretas. */
  borda: string;
  /** Paleta dos gráficos. */
  paleta: string[];
}

const TEMA: Tema = {
  cor: COR_PADRAO,
  corTexto: melhorTexto(COR_PADRAO).cor,
  corTitulo: COR_PADRAO,
  zebra: misturar(COR_PADRAO, '#ffffff', 0.94),
  borda: misturar(COR_PADRAO, '#ffffff', 0.72),
  paleta: paletaGrafico(COR_PADRAO, MAX_FATIAS),
};

/** Normaliza para WinAnsi: pontuação tipográfica → ASCII; resto fora do latin1 cai. */
function paraWinAnsi(texto: string): string {
  return (
    texto
      .replace(/[‘’‚]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/[●▪]/g, '•')
      .replace(/\u00a0/g, ' ')
      // • (•) fica: o pdfkit o mapeia para o bullet do WinAnsi (0x95).
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ•]/g, '')
  );
}

/** Um trecho inline com estilo resolvido (fonte/cor/link). */
interface Trecho {
  texto: string;
  negrito: boolean;
  italico: boolean;
  codigo: boolean;
  href?: string;
  /** Cor específica (marcador de lista, etc.); ausente → cor de texto padrão. */
  cor?: string;
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
function escreverTrechos(
  doc: Doc,
  trechos: Trecho[],
  tema: Tema,
  opts: { indent?: number } = {},
): void {
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
      .fillColor(t.href ? tema.corTitulo : (t.cor ?? '#111111'));
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

function renderizarTabela(doc: Doc, tb: Tokens.Table, tema: Tema): void {
  const nCols = tb.header.length;
  if (nCols === 0) return;
  const largura = larguraUtil(doc);
  const padding = 6;
  const padV = 5;

  const linhaCells = (cells: Array<{ tokens?: Token[] }>): string[] =>
    cells.map((c) => paraWinAnsi(textoPlano(trechosDe(c.tokens))));
  const cabecalho = linhaCells(tb.header);
  const corpo = tb.rows.map(linhaCells);

  // Larguras proporcionais ao conteúdo (com piso) — coluna de rótulo respira,
  // coluna de número não desperdiça página.
  const pesos = cabecalho.map((h, i) => {
    let m = Math.min(h.length, 40);
    for (const linha of corpo) m = Math.max(m, Math.min((linha[i] ?? '').length, 40));
    return Math.max(m, 5);
  });
  const somaPesos = pesos.reduce((a, b) => a + b, 0);
  const piso = Math.min(56, largura / nCols);
  const brutas = pesos.map((p) => Math.max((p / somaPesos) * largura, piso));
  const somaBrutas = brutas.reduce((a, b) => a + b, 0);
  const colWs = brutas.map((w) => (w * largura) / somaBrutas);

  // Colunas 100% numéricas alinham à direita (número se lê pela ordem de grandeza).
  const numerica = cabecalho.map(
    (_, i) =>
      corpo.length > 0 &&
      corpo.every((l) => {
        const c = (l[i] ?? '').trim();
        return c !== '' && /^[0-9.,%+\-R$()\s]+$/.test(c);
      }),
  );

  const desenharLinha = (
    celulas: string[],
    opcoes: { cabecalho?: boolean; zebra?: boolean },
  ): void => {
    const fonte = opcoes.cabecalho ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(fonte).fontSize(TAM_TEXTO - 0.5);
    const alturas = celulas.map(
      (c, i) => doc.heightOfString(c || ' ', { width: colWs[i]! - padding * 2 }) + padV * 2,
    );
    const alturaLinha = Math.max(...alturas, TAM_TEXTO + padV * 2);
    garantirEspaco(doc, alturaLinha);
    const y = doc.y;
    const x0 = doc.page.margins.left;
    if (opcoes.cabecalho) doc.rect(x0, y, largura, alturaLinha).fill(tema.cor);
    else if (opcoes.zebra) doc.rect(x0, y, largura, alturaLinha).fill(tema.zebra);
    let x = x0;
    for (let i = 0; i < nCols; i++) {
      doc
        .font(fonte)
        .fontSize(TAM_TEXTO - 0.5)
        .fillColor(opcoes.cabecalho ? tema.corTexto : '#26262b')
        .text(celulas[i] || ' ', x + padding, y + padV, {
          width: colWs[i]! - padding * 2,
          align: numerica[i] ? 'right' : 'left',
        });
      x += colWs[i]!;
    }
    if (!opcoes.cabecalho) {
      doc
        .lineWidth(0.5)
        .strokeColor('#e4e4e7')
        .moveTo(x0, y + alturaLinha)
        .lineTo(x0 + largura, y + alturaLinha)
        .stroke();
    }
    doc.x = x0;
    doc.y = y + alturaLinha;
  };

  desenharLinha(cabecalho, { cabecalho: true });
  corpo.forEach((linha, idx) => desenharLinha(linha, { zebra: idx % 2 === 1 }));
  doc.fillColor('#111111').moveDown(0.6);
}

function renderizarLista(doc: Doc, lista: Tokens.List, nivel: number, tema: Tema): void {
  const indent = nivel * 16;
  lista.items.forEach((item, idx) => {
    const marcador = lista.ordered
      ? `${(typeof lista.start === 'number' && lista.start > 1 ? lista.start : 1) + idx}. `
      : '• ';
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
    const marca: Trecho = {
      texto: paraWinAnsi(marcador + prefixo),
      negrito: lista.ordered,
      italico: false,
      codigo: false,
      cor: tema.corTitulo,
    };
    const trechos = [marca, ...trechosDe(inlineTokens)];
    garantirEspaco(doc, TAM_TEXTO * 2);
    escreverTrechos(doc, trechos, tema, { indent });
    doc.moveDown(-0.3); // itens de lista mais compactos que parágrafos
    for (const sub of sublistas) renderizarLista(doc, sub, nivel + 1, tema);
  });
  doc.moveDown(0.5);
}

function renderizarCodigo(doc: Doc, texto: string): void {
  doc.font('Courier').fontSize(TAM_TEXTO - 1.5);
  const largura = larguraUtil(doc);
  const hTexto = doc.heightOfString(texto || ' ', { width: largura - 24 });
  const hBloco = hTexto + 16;
  const alturaPagina = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  if (hBloco <= alturaPagina) {
    garantirEspaco(doc, hBloco);
    const x0 = doc.page.margins.left;
    const y0 = doc.y;
    doc.lineWidth(0.5).roundedRect(x0, y0, largura, hBloco, 4).fillAndStroke('#f4f4f5', '#e4e4e7');
    doc
      .font('Courier')
      .fontSize(TAM_TEXTO - 1.5)
      .fillColor('#3f3f46')
      .text(texto, x0 + 12, y0 + 8, { width: largura - 24 });
    doc.x = x0;
    doc.y = y0 + hBloco;
  } else {
    // Maior que uma página: sem fundo (o pdfkit pagina o texto sozinho).
    doc.fillColor('#3f3f46').text(texto, doc.page.margins.left + 12, doc.y, {
      width: largura - 12,
    });
  }
  doc.fillColor('#111111').moveDown(0.6);
}

function renderizarBlocos(doc: Doc, tokens: Token[], tema: Tema): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        const nivel = Math.min(h.depth, 3);
        const tam = TAM_TITULOS[nivel - 1]!;
        garantirEspaco(doc, tam * 3);
        doc.moveDown(nivel === 1 ? 0.6 : 0.4);
        doc
          .font('Helvetica-Bold')
          .fontSize(tam)
          .fillColor(nivel === 1 ? tema.corTitulo : nivel === 2 ? '#18181b' : '#3f3f46')
          .text(paraWinAnsi(textoPlano(trechosDe(h.tokens))), doc.page.margins.left, doc.y, {
            width: larguraUtil(doc),
          });
        doc.fillColor('#111111').moveDown(0.4);
        break;
      }
      case 'paragraph':
        escreverTrechos(doc, trechosDe((t as Tokens.Paragraph).tokens), tema);
        break;
      case 'code': {
        const c = t as Tokens.Code;
        if ((c.lang ?? '').trim().toLowerCase() === 'grafico') {
          // Bloco ```grafico (D-027): JSON validado → gráfico vetorial desenhado.
          const spec = validarGrafico(c.text);
          garantirEspaco(doc, alturaGrafico(spec));
          renderizarGrafico(
            doc,
            spec,
            { cor: tema.cor, paleta: tema.paleta },
            { x: doc.page.margins.left, largura: larguraUtil(doc) },
          );
          doc.moveDown(0.6);
        } else {
          renderizarCodigo(doc, paraWinAnsi(c.text));
        }
        break;
      }
      case 'blockquote': {
        const paginasAntes = doc.bufferedPageRange().count;
        const x0 = doc.page.margins.left;
        const y0 = doc.y;
        doc.fillColor('#52525b');
        doc.page.margins.left = MARGEM + 14;
        renderizarBlocos(doc, (t as Tokens.Blockquote).tokens, tema);
        doc.page.margins.left = MARGEM;
        doc.x = MARGEM;
        // Barra lateral só quando o bloco coube numa página (sem quebra no meio).
        if (doc.bufferedPageRange().count === paginasAntes && doc.y > y0) {
          doc.rect(x0 + 2, y0 - 2, 3, doc.y - y0 - 4).fill(tema.cor);
        }
        doc.fillColor('#111111');
        break;
      }
      case 'list':
        renderizarLista(doc, t as Tokens.List, 0, tema);
        break;
      case 'table':
        renderizarTabela(doc, t as Tokens.Table, tema);
        break;
      case 'hr': {
        garantirEspaco(doc, 16);
        const y = doc.y + 4;
        doc
          .lineWidth(0.5)
          .strokeColor(tema.borda)
          .moveTo(doc.page.margins.left, y)
          .lineTo(doc.page.width - doc.page.margins.right, y)
          .stroke();
        doc.y = y + 8;
        break;
      }
      case 'html': {
        const texto = paraWinAnsi((t as Tokens.HTML).raw.trim());
        if (texto) escreverTrechos(doc, [trecho(texto, {})], tema);
        break;
      }
      case 'text':
        escreverTrechos(doc, trechosDe((t as Tokens.Text).tokens ?? [t]), tema);
        break;
      default: {
        const cru = 'raw' in t && typeof t.raw === 'string' ? t.raw.trim() : '';
        if (cru) escreverTrechos(doc, [trecho(cru, {})], tema);
      }
    }
  }
}

/** Capa (D-027): faixa colorida neutra com o título do documento e a data. */
function desenharCapa(doc: Doc, titulo: string | null, tema: Tema): void {
  const pageW = doc.page.width;
  const wUtil = pageW - MARGEM * 2;
  const t = titulo?.trim() ? paraWinAnsi(titulo.trim()) : '';
  doc.font('Helvetica-Bold').fontSize(19);
  const hTitulo = t ? doc.heightOfString(t, { width: wUtil }) : 0;
  const topo = 26;
  const faixaH = topo + 20 + (t ? hTitulo + 10 : 0) + 16;
  doc.rect(0, 0, pageW, faixaH).fill(tema.cor);

  const data = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(tema.corTexto)
    .fillOpacity(0.85)
    .text(`Gerado em ${data}`, MARGEM, topo, {
      width: wUtil,
      align: 'right',
      lineBreak: false,
    });
  doc.fillOpacity(1);
  if (t) {
    doc
      .font('Helvetica-Bold')
      .fontSize(19)
      .fillColor(tema.corTexto)
      .text(t, MARGEM, topo + 20, { width: wUtil });
  }
  doc.x = MARGEM;
  doc.y = faixaH + 26;
  doc.fillColor('#111111');
}

/** Rodapé em todas as páginas (segunda passada, com `bufferPages`). */
function desenharRodapes(doc: Doc, tema: Tema): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // sem isso, escrever aqui embaixo criaria página nova
    const y = doc.page.height - 30;
    doc
      .lineWidth(0.5)
      .strokeColor(tema.borda)
      .moveTo(MARGEM, y - 6)
      .lineTo(doc.page.width - MARGEM, y - 6)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#8a8a8a')
      .text(`Página ${i + 1} de ${range.count}`, MARGEM, y, {
        width: doc.page.width - MARGEM * 2,
        align: 'right',
        lineBreak: false,
      });
    doc.page.margins.bottom = margemInferior;
  }
}

/**
 * Renderiza `markdown` num PDF (A4) com o template neutro do produto (D-027) e
 * devolve o buffer completo. `titulo`, quando presente, entra na capa. Lança
 * `pdf_falhou:<motivo>` em erro (inclusive `grafico_invalido:` de bloco ```grafico).
 */
export async function gerarPdfDeMarkdown(titulo: string | null, markdown: string): Promise<Buffer> {
  try {
    const tema = TEMA;
    const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      margins: { top: MARGEM, bottom: MARGEM, left: MARGEM, right: MARGEM },
      info: titulo ? { Title: paraWinAnsi(titulo) } : {},
    });
    const partes: Buffer[] = [];
    const pronto = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c: Buffer) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);
    });

    desenharCapa(doc, titulo, tema);
    renderizarBlocos(doc, tokens, tema);
    desenharRodapes(doc, tema);
    doc.end();
    return await pronto;
  } catch (err) {
    throw new Error(`pdf_falhou:${(err as Error).message}`);
  }
}
