import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RespostaDetalheChamado } from '@chamados/cliente-api';
import type { OperacoesChamados } from '../chamados/tipos';

/**
 * Entrada do planejador (specs/forja/05 §4.3; 04 §2, §4.2): o app adquire e
 * SANITIZA o que veio do cliente antes de gravar em `<exec>/entrada/` e antes
 * de montar o B5. O agente nunca lê a resposta crua da API.
 *
 * - comentários HTML (`<!-- … -->`) e caracteres invisíveis/de controle
 *   (zero-width, bidi) são removidos — são o canal clássico de instrução
 *   escondida que o humano não vê na tela do Chamados;
 * - HTML residual é neutralizado (`<tag` → `&lt;tag`);
 * - cada texto tem teto, e o excedente é truncado com aviso;
 * - anexos vão para `entrada/anexos/<id>-<basename seguro>` (0600), fora da
 *   worktree; nada é executado nem descompactado.
 */

/** Teto por texto do cliente (descrição, cada mensagem). */
export const TETO_TEXTO_CLIENTE = 20_000;
/** Teto do `chamado.md` inteiro. */
export const TETO_ENTRADA = 200_000;
/** Anexo maior que isto não é baixado (o nome aparece com aviso). */
export const TETO_ANEXO_BYTES = 20 * 1024 * 1024;

// Zero-width, marcas bidi, separadores invisíveis, BOM e "tag characters".
const INVISIVEIS =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;
// Controle C0/C1, menos \t e \n.
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function sanitizarTextoCliente(texto: string, teto = TETO_TEXTO_CLIENTE): string {
  let t = (texto ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  t = t.replace(INVISIVEIS, '').replace(CONTROLE, '');
  t = t.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
  if (t.length > teto) {
    const omitidos = t.length - teto;
    t = `${t.slice(0, teto)}\n\n[texto truncado pelo app: ${omitidos} caractere(s) omitido(s)]`;
  }
  return t;
}

/** `<anexo_id>-<basename seguro>` (05 §4.3). */
export function nomeAnexoSeguro(id: string, nome: string): string {
  const base = basename(nome.replace(/\\/g, '/'))
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  const idSeguro = id.replace(/[^\w-]+/g, '').slice(0, 40);
  return `${idSeguro}-${base || 'anexo'}`;
}

/** Detalhe do chamado com todos os textos do cliente sanitizados. */
export function detalheSanitizado(d: RespostaDetalheChamado): RespostaDetalheChamado {
  return {
    chamado: {
      ...d.chamado,
      titulo: sanitizarTextoCliente(d.chamado.titulo, 500),
      descricao: sanitizarTextoCliente(d.chamado.descricao),
    },
    mensagens: d.mensagens.map((m) => ({
      ...m,
      autor_nome: m.autor_nome === null ? null : sanitizarTextoCliente(m.autor_nome, 200),
      corpo: sanitizarTextoCliente(m.corpo),
    })),
  };
}

/** `entrada/chamado.md`: o chamado já normalizado, com teto total (05 §4.3). */
export function chamadoMarkdown(d: RespostaDetalheChamado, anexos: readonly string[]): string {
  const c = d.chamado;
  const partes = [
    `# Chamado #${c.numero}: ${c.titulo}`,
    '',
    `- Status: ${c.status}`,
    `- Natureza: ${c.natureza ?? ''}`,
    `- Prioridade: ${c.prioridade}`,
    `- Sistema: ${c.sistema_nome ?? ''}`,
    '',
    '## Descrição',
    '',
    c.descricao,
    '',
    '## Conversa',
    ...d.mensagens.flatMap((m) => [
      '',
      `### ${m.autor_nome ?? '(sem nome)'} (${m.autor_papel ?? '?'}, ${m.visibilidade}) — ${m.created_at ?? ''}`,
      '',
      m.corpo,
    ]),
    '',
    '## Anexos (em anexos/)',
    '',
    anexos.length ? anexos.map((a) => `- ${a}`).join('\n') : '(nenhum)',
    '',
  ];
  const texto = partes.join('\n');
  return texto.length > TETO_ENTRADA
    ? `${texto.slice(0, TETO_ENTRADA)}\n\n[entrada truncada pelo app: ${texto.length - TETO_ENTRADA} caractere(s) omitido(s)]\n`
    : texto;
}

/**
 * Baixa os anexos do chamado (descrição e mensagens) para `entrada/anexos/`.
 * Devolve os nomes EFETIVAMENTE gravados (falha de download vira aviso no nome).
 */
export async function baixarAnexos(
  api: Pick<OperacoesChamados, 'baixarAnexo'>,
  d: RespostaDetalheChamado,
  dirEntrada: string,
): Promise<string[]> {
  const todos = [...d.chamado.anexos, ...d.mensagens.flatMap((m) => m.anexos ?? [])];
  const vistos = new Set<string>();
  const nomes: string[] = [];
  if (todos.length === 0) return nomes;
  const dir = join(dirEntrada, 'anexos');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const a of todos) {
    if (vistos.has(a.id)) continue;
    vistos.add(a.id);
    const nome = nomeAnexoSeguro(a.id, a.nome_arquivo);
    if (a.tamanho_bytes > TETO_ANEXO_BYTES) {
      nomes.push(`${nome} (não baixado: maior que ${TETO_ANEXO_BYTES / 1024 / 1024} MB)`);
      continue;
    }
    try {
      const arq = await api.baixarAnexo(a.id);
      await writeFile(join(dir, nome), arq.corpo, { mode: 0o600 });
      nomes.push(nome);
    } catch (e) {
      nomes.push(`${nome} (não baixado: ${(e as Error).message.slice(0, 120)})`);
    }
  }
  return nomes;
}
