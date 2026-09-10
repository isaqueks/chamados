import type { DocRico, NoRichText, MarcaRichText } from './rich-text';

/**
 * Projeção de um `DocRico` (ProseMirror/TipTap já validado) em **markdown** —
 * a saída "rica" da API `/api/v1` (specs/11 §1.5, D-035). É o inverso de
 * `markdownParaDoc`: opera sobre o documento FONTE (não sobre o HTML), então
 * não há parse de HTML nem risco de interpretar marcação que o pipeline de
 * escrita já rejeitou. Nós fora da allowlist são ignorados, como no render HTML.
 *
 * Imagens inline viram `![alt](url)`; a URL vem de `opts.urlImagem`, para que
 * o consumidor (a API) aponte para a rota que ELE serve (`/api/v1/anexos/…`).
 */

export interface OpcoesMarkdown {
  /** Reescreve a `src` interna (`/api/anexos/<id>`) para a URL de saída. */
  urlImagem?: (src: string) => string;
}

function escaparTextoMd(texto: string): string {
  // Só o que quebraria a estrutura: marcadores de ênfase/código e crases.
  return texto.replace(/([\\`*_~])/g, '\\$1');
}

function aplicarMarcas(texto: string, marcas: MarcaRichText[]): string {
  let s = texto;
  const tem = (t: string) => marcas.some((m) => m.type === t);
  if (tem('code')) return `\`${texto.replace(/`/g, '\\`')}\``;
  s = escaparTextoMd(s);
  if (tem('bold')) s = `**${s}**`;
  if (tem('italic')) s = `*${s}*`;
  if (tem('strike')) s = `~~${s}~~`;
  // `underline` não existe em markdown: cai no texto simples.
  const link = marcas.find((m) => m.type === 'link');
  if (link) {
    const href = String(link.attrs?.href ?? '');
    if (href) s = `[${s}](${href})`;
  }
  return s;
}

function inline(no: NoRichText, opts: OpcoesMarkdown): string {
  switch (no.type) {
    case 'text':
      return aplicarMarcas(no.text ?? '', no.marks ?? []);
    case 'hardBreak':
      return '  \n';
    case 'image': {
      const src = String(no.attrs?.src ?? '');
      if (!src) return '';
      const alt = String(no.attrs?.alt ?? 'imagem').replace(/[[\]]/g, '');
      return `![${alt}](${opts.urlImagem ? opts.urlImagem(src) : src})`;
    }
    default:
      return (no.content ?? []).map((f) => inline(f, opts)).join('');
  }
}

function textoCelula(no: NoRichText, opts: OpcoesMarkdown): string {
  // Célula pode ter parágrafos: junta em uma linha (tabela markdown é 1 linha).
  return (no.content ?? [])
    .map((p) => inline(p, opts))
    .join(' ')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function tabela(no: NoRichText, opts: OpcoesMarkdown): string {
  const linhas = (no.content ?? []).filter((l) => l.type === 'tableRow');
  if (linhas.length === 0) return '';
  const celulas = linhas.map((l) => (l.content ?? []).map((c) => textoCelula(c, opts)));
  const colunas = Math.max(...celulas.map((c) => c.length));
  const linha = (cs: string[]) =>
    `| ${Array.from({ length: colunas }, (_, i) => cs[i] ?? '').join(' | ')} |`;
  const primeiraEhCabecalho = (linhas[0]!.content ?? []).every((c) => c.type === 'tableHeader');
  const cabecalho = primeiraEhCabecalho ? celulas[0]! : Array.from({ length: colunas }, () => '');
  const corpo = primeiraEhCabecalho ? celulas.slice(1) : celulas;
  const separador = `| ${Array.from({ length: colunas }, () => '---').join(' | ')} |`;
  return [linha(cabecalho), separador, ...corpo.map(linha)].join('\n');
}

function bloco(no: NoRichText, opts: OpcoesMarkdown, indent = ''): string {
  switch (no.type) {
    case 'paragraph':
      return inline(no, opts);
    case 'heading': {
      const nivel = Math.min(3, Math.max(1, Number(no.attrs?.level ?? 1)));
      return `${'#'.repeat(nivel)} ${inline(no, opts)}`;
    }
    case 'blockquote':
      return blocos(no.content ?? [], opts)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'codeBlock': {
      const codigo = (no.content ?? []).map((f) => f.text ?? '').join('');
      return `\`\`\`\n${codigo}\n\`\`\``;
    }
    case 'bulletList':
      return (no.content ?? []).map((li) => itemLista(li, '- ', opts, indent)).join('\n');
    case 'orderedList': {
      const start = Number(no.attrs?.start);
      let n = Number.isFinite(start) && start > 1 ? Math.trunc(start) : 1;
      return (no.content ?? []).map((li) => itemLista(li, `${n++}. `, opts, indent)).join('\n');
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return tabela(no, opts);
    case 'image':
      return inline(no, opts);
    default:
      return blocos(no.content ?? [], opts);
  }
}

function itemLista(li: NoRichText, marcador: string, opts: OpcoesMarkdown, indent: string): string {
  const filhos = li.content ?? [];
  const partes = filhos.map((f) => bloco(f, opts, indent + '  '));
  const [primeiro = '', ...resto] = partes;
  const continuacao = resto
    .filter((p) => p.length > 0)
    .map((p) =>
      p
        .split('\n')
        .map((l) => `${indent}  ${l}`)
        .join('\n'),
    );
  return [`${indent}${marcador}${primeiro}`, ...continuacao].join('\n');
}

function blocos(nos: NoRichText[], opts: OpcoesMarkdown): string {
  return nos
    .map((n) => bloco(n, opts))
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** Converte o documento inteiro em markdown. Nunca lança. */
export function docParaMarkdown(doc: DocRico | unknown, opts: OpcoesMarkdown = {}): string {
  const d = doc as DocRico | null;
  if (!d || typeof d !== 'object' || d.type !== 'doc') return '';
  return blocos(d.content ?? [], opts).trim();
}
