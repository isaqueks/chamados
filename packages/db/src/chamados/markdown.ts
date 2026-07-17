import { marked, type Token, type Tokens } from 'marked';
import { textoParaDoc, type DocRico, type MarcaRichText, type NoRichText } from './rich-text';

/**
 * Conversor MARKDOWN → DocRico (tarefa #15): as saídas da IA (respostas ao
 * cliente, diagnósticos, SPECs) são markdown — antes entravam no pipeline como
 * texto plano (via `textoParaDoc`) e o cliente via `# SPEC` cru. Este conversor
 * usa o LEXER do marked (nunca o renderer — nenhum HTML é gerado aqui) e mapeia
 * os tokens para os MESMOS nós da allowlist do pipeline de rich text
 * (`validarDocRico` continua sendo a fronteira: tudo que sair daqui passa pela
 * validação/sanitização normal, como um doc vindo do editor TipTap).
 *
 * Cobertura: headings (níveis clampados 1–3 pela validação), parágrafos,
 * listas (ordenadas/não ordenadas/tarefas — tarefas viram texto "[ ]"/"[x]"),
 * código (bloco e inline), blockquote, tabelas GFM, hr, links (href seguro é
 * revalidado pela allowlist), bold/itálico/strike, quebras. HTML embutido NÃO
 * vira nó (entra como texto plano — defesa em profundidade); imagens de URL
 * externa viram o texto alternativo (o pipeline só aceita imagens data:/refs
 * internas).
 *
 * Falha de parse NUNCA quebra a mensagem: cai no `textoParaDoc` (texto plano).
 */

/** Desfaz as entidades básicas que o lexer do marked escapa em `text`. */
function desescapar(texto: string): string {
  return texto
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textoComMarcas(texto: string, marcas: MarcaRichText[]): NoRichText | null {
  if (texto.length === 0) return null;
  const no: NoRichText = { type: 'text', text: texto };
  if (marcas.length > 0) no.marks = [...marcas];
  return no;
}

/** Converte tokens INLINE (dentro de parágrafo/heading/célula) em nós de texto. */
function inline(tokens: Token[] | undefined, marcas: MarcaRichText[] = []): NoRichText[] {
  const out: NoRichText[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text': {
        const tk = t as Tokens.Text;
        // `text` pode carregar sub-tokens (ex.: itens de lista "soltos").
        if (tk.tokens && tk.tokens.length > 0) out.push(...inline(tk.tokens, marcas));
        else {
          const no = textoComMarcas(desescapar(tk.text), marcas);
          if (no) out.push(no);
        }
        break;
      }
      case 'escape': {
        const no = textoComMarcas(desescapar((t as Tokens.Escape).text), marcas);
        if (no) out.push(no);
        break;
      }
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, [...marcas, { type: 'bold' }]));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, [...marcas, { type: 'italic' }]));
        break;
      case 'del':
        out.push(...inline((t as Tokens.Del).tokens, [...marcas, { type: 'strike' }]));
        break;
      case 'codespan': {
        const no = textoComMarcas(desescapar((t as Tokens.Codespan).text), [
          ...marcas,
          { type: 'code' },
        ]);
        if (no) out.push(no);
        break;
      }
      case 'link': {
        const lk = t as Tokens.Link;
        // A allowlist revalida o href (https?/mailto); href inseguro perde a marca.
        out.push(...inline(lk.tokens, [...marcas, { type: 'link', attrs: { href: lk.href } }]));
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        // Imagem de URL externa não sobrevive à allowlist — preserva o alt como texto.
        const no = textoComMarcas(desescapar(img.text || img.href), marcas);
        if (no) out.push(no);
        break;
      }
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      default: {
        // Qualquer inline desconhecido degrada para o texto cru (nunca HTML).
        const cru = 'raw' in t && typeof t.raw === 'string' ? t.raw : '';
        const no = textoComMarcas(cru, marcas);
        if (no) out.push(no);
      }
    }
  }
  return out;
}

/** Embrulha nós inline num parágrafo (nó de bloco obrigatório em listItem etc.). */
function paragrafo(filhos: NoRichText[]): NoRichText {
  return filhos.length > 0 ? { type: 'paragraph', content: filhos } : { type: 'paragraph' };
}

function converterLista(lista: Tokens.List): NoRichText {
  const itens: NoRichText[] = lista.items.map((item) => {
    // O marked emite um token `checkbox` próprio em itens de tarefa — o estado
    // é preservado pelo marcador textual abaixo (não há taskList na allowlist).
    const blocos = blocosDe(item.tokens.filter((t) => t.type !== 'checkbox'));
    // Item de TAREFA (GFM "- [ ]"): não há taskList na allowlist — preserva o
    // estado como texto no início do item.
    if (item.task) {
      const marcador: NoRichText = { type: 'text', text: item.checked ? '[x] ' : '[ ] ' };
      const primeiro = blocos[0];
      if (primeiro && primeiro.type === 'paragraph') {
        primeiro.content = [marcador, ...(primeiro.content ?? [])];
      } else {
        blocos.unshift(paragrafo([marcador]));
      }
    }
    return {
      type: 'listItem',
      content: blocos.length > 0 ? blocos : [paragrafo([])],
    };
  });
  if (lista.ordered) {
    const start = typeof lista.start === 'number' && lista.start > 1 ? lista.start : undefined;
    return {
      type: 'orderedList',
      ...(start ? { attrs: { start } } : {}),
      content: itens,
    };
  }
  return { type: 'bulletList', content: itens };
}

function converterTabela(tb: Tokens.Table): NoRichText {
  const linhaCabecalho: NoRichText = {
    type: 'tableRow',
    content: tb.header.map((cel) => ({
      type: 'tableHeader',
      content: [paragrafo(inline(cel.tokens))],
    })),
  };
  const linhas: NoRichText[] = tb.rows.map((cells) => ({
    type: 'tableRow',
    content: cells.map((cel) => ({
      type: 'tableCell',
      content: [paragrafo(inline(cel.tokens))],
    })),
  }));
  return { type: 'table', content: [linhaCabecalho, ...linhas] };
}

/** Converte tokens de BLOCO em nós de bloco. */
function blocosDe(tokens: Token[]): NoRichText[] {
  const out: NoRichText[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'checkbox': // tratado em converterLista (marcador textual)
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({
          type: 'heading',
          attrs: { level: h.depth },
          content: inline(h.tokens),
        });
        break;
      }
      case 'paragraph':
        out.push(paragrafo(inline((t as Tokens.Paragraph).tokens)));
        break;
      case 'code': {
        const c = t as Tokens.Code;
        out.push({
          type: 'codeBlock',
          ...(c.lang ? { attrs: { language: c.lang } } : {}),
          content: c.text.length > 0 ? [{ type: 'text', text: c.text }] : undefined,
        });
        break;
      }
      case 'blockquote':
        out.push({ type: 'blockquote', content: blocosDe((t as Tokens.Blockquote).tokens) });
        break;
      case 'list':
        out.push(converterLista(t as Tokens.List));
        break;
      case 'table':
        out.push(converterTabela(t as Tokens.Table));
        break;
      case 'hr':
        out.push({ type: 'horizontalRule' });
        break;
      case 'html': {
        // HTML embutido NUNCA vira nó: degrada para texto plano (defesa em
        // profundidade — a allowlist descartaria de qualquer forma).
        const texto = (t as Tokens.HTML).raw.trim();
        if (texto.length > 0) out.push(paragrafo([{ type: 'text', text: texto }]));
        break;
      }
      case 'text': {
        // Bloco "solto" (ex.: dentro de listItem sem parágrafo explícito).
        const tk = t as Tokens.Text;
        out.push(paragrafo(inline(tk.tokens && tk.tokens.length > 0 ? tk.tokens : [t])));
        break;
      }
      default: {
        const cru = 'raw' in t && typeof t.raw === 'string' ? t.raw.trim() : '';
        if (cru.length > 0) out.push(paragrafo([{ type: 'text', text: cru }]));
      }
    }
  }
  return out;
}

/**
 * Converte markdown num `DocRico` pronto para o pipeline de rich text
 * (`validarDocRico` + materialização). Nunca lança: qualquer erro de parse cai
 * no texto plano (`textoParaDoc`).
 */
export function markdownParaDoc(markdown: string): DocRico {
  try {
    // `breaks: true` (GFM "hard breaks", como em comentários do GitHub): um \n
    // simples dentro do parágrafo vira token `br` → nó `hardBreak` → `<br>`.
    // Com false, o \n ficava literal no texto e o HTML colapsava em espaço —
    // as respostas da IA perdiam TODA quebra de linha simples.
    const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
    const content = blocosDe(tokens);
    if (content.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
    return { type: 'doc', content };
  } catch {
    return textoParaDoc(markdown);
  }
}
