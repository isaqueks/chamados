import type { NovoEventoForja } from '../../comum/protocolo-eventos';

/**
 * Normalizador do payload dos eventos (specs/forja/01 §8.2, 02 §4.8, 05 §8.2).
 *
 * POR QUE enxugar antes de persistir: o SQLite (`evento`, append-only, nunca
 * UPDATE) e o SSE carregam o que a UI DESENHA — uma linha do feed, a entrada da
 * ferramenta resumida, o texto do agente truncado. O payload integral fica só em
 * `etapas/<n>/eventos.jsonl` (gravador-bruto). Teto de 8 KB por `dados`.
 *
 * POR QUE redigir aqui: o app conhece valores sensíveis (token de boot, valores
 * dos `.env` copiados para a worktree, `ANTHROPIC_API_KEY`) e o agente, em
 * bypass, pode imprimi-los num `cat .env`. Tudo que vira `evento`,
 * `eventos.jsonl`, relatório ou nota passa pelo `Redator`, que troca valores
 * conhecidos e padrões genéricos (PEM, `ghp_`/`github_pat_`, `sk-ant-`,
 * `AKIA…`, URL de conexão com senha) por `«redigido»`. É redação de log, não
 * o detector que BLOQUEIA o outbox (05 §8.2, módulo de segredos).
 */

export const MARCA_REDIGIDO = '«redigido»';

/** Valor conhecido mais curto que isso não é redigido (evita apagar "1", "dev"…). */
export const TAMANHO_MINIMO_SEGREDO = 6;

/** Teto do `dados` serializado (02 §4.8: "≤ 8 KB; acima disso trunca"). */
export const MAX_BYTES_PAYLOAD = 8 * 1024;
export const MAX_TEXTO_PADRAO = 4000;
export const MAX_RESUMO = 300;
export const MAX_RESUMO_ENTRADA = 240;

interface PadraoSegredo {
  regex: RegExp;
  troca: string;
}

/**
 * Padrões genéricos. Nenhum atravessa `"`: aplicados a uma linha JSON crua, a
 * troca nunca quebra a sintaxe do JSON (o bruto continua parseável).
 */
const PADROES: readonly PadraoSegredo[] = [
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    troca: MARCA_REDIGIDO,
  },
  // PEM cortado (sem END, ex.: texto truncado): redige até o fim da string.
  { regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*/g, troca: MARCA_REDIGIDO },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, troca: MARCA_REDIGIDO },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, troca: MARCA_REDIGIDO },
  { regex: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, troca: MARCA_REDIGIDO },
  { regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, troca: MARCA_REDIGIDO },
  // scheme://usuario:SENHA@host → mantém usuário e host.
  {
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:)([^\s@/"'\\]+)(@)/gi,
    troca: `$1${MARCA_REDIGIDO}$3`,
  },
  { regex: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, troca: `$1${MARCA_REDIGIDO}` },
];

export class Redator {
  private valores: string[] = [];

  constructor(valores: Iterable<string> = []) {
    this.adicionar(valores);
  }

  /**
   * Registra valores sensíveis conhecidos. Guarda também a forma escapada em
   * JSON (um valor com `"` ou `\` aparece assim numa linha do stream).
   */
  adicionar(valores: Iterable<string>): void {
    const conjunto = new Set(this.valores);
    for (const v of valores) {
      if (typeof v !== 'string' || v.length < TAMANHO_MINIMO_SEGREDO) continue;
      conjunto.add(v);
      const escapado = JSON.stringify(v).slice(1, -1);
      if (escapado !== v) conjunto.add(escapado);
    }
    // Mais longos primeiro: um valor que contém outro é trocado inteiro.
    this.valores = [...conjunto].sort((a, b) => b.length - a.length);
  }

  get totalValores(): number {
    return this.valores.length;
  }

  redigir(texto: string): string {
    let saida = texto;
    for (const valor of this.valores) {
      if (saida.includes(valor)) saida = saida.split(valor).join(MARCA_REDIGIDO);
    }
    for (const { regex, troca } of PADROES) {
      regex.lastIndex = 0;
      saida = saida.replace(regex, troca);
    }
    return saida;
  }
}

/** Redator sem valores conhecidos: só os padrões genéricos. */
export const REDATOR_GENERICO = new Redator();

export interface TextoTruncado {
  texto: string;
  truncado: boolean;
}

/** Corta em `max` code points (nunca no meio de um par substituto) e marca com `…`. */
export function truncarTexto(texto: string, max: number): TextoTruncado {
  if (texto.length <= max) return { texto, truncado: false };
  const pontos = Array.from(texto);
  if (pontos.length <= max) return { texto, truncado: false };
  return { texto: `${pontos.slice(0, Math.max(0, max - 1)).join('')}…`, truncado: true };
}

/** Uma linha: colapsa espaços/quebras e trunca. */
export function umaLinha(texto: string, max: number = MAX_RESUMO): string {
  return truncarTexto(texto.replace(/\s+/g, ' ').trim(), max).texto;
}

function campo(entrada: Record<string, unknown>, ...nomes: string[]): string | null {
  for (const n of nomes) {
    const v = entrada[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Entrada de ferramenta em UMA linha para o feed (`agente.ferramenta`,
 * `permissao.negada`): o caminho editado, o comando, o padrão buscado, o
 * subagente despachado. Nunca o conteúdo de um `Write`/`Edit` (vai no bruto).
 */
export function resumirEntradaFerramenta(
  ferramenta: string,
  entrada: unknown,
  redator: Redator = REDATOR_GENERICO,
): string {
  const e =
    entrada !== null && typeof entrada === 'object' ? (entrada as Record<string, unknown>) : {};
  let texto: string;
  switch (ferramenta) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      texto = campo(e, 'file_path', 'notebook_path', 'path') ?? '';
      break;
    case 'Bash':
      texto = campo(e, 'command') ?? '';
      break;
    case 'Grep':
    case 'Glob': {
      const padrao = campo(e, 'pattern') ?? '';
      const onde = campo(e, 'path', 'glob');
      texto = onde ? `${padrao} em ${onde}` : padrao;
      break;
    }
    case 'Agent':
    case 'Task': {
      const tipo = campo(e, 'subagent_type') ?? 'subagente';
      const desc = campo(e, 'description');
      texto = desc ? `${tipo}: ${desc}` : tipo;
      break;
    }
    case 'WebFetch':
      texto = campo(e, 'url') ?? '';
      break;
    case 'WebSearch':
      texto = campo(e, 'query') ?? '';
      break;
    case 'TodoWrite': {
      const todos = Array.isArray(e.todos) ? e.todos.length : 0;
      texto = `${todos} ${todos === 1 ? 'item' : 'itens'}`;
      break;
    }
    default: {
      let json: string;
      try {
        json = JSON.stringify(entrada) ?? '';
      } catch {
        json = '';
      }
      texto = json === '{}' ? '' : json;
    }
  }
  return umaLinha(redator.redigir(texto), MAX_RESUMO_ENTRADA);
}

export interface OpcoesEnxugar {
  redator?: Redator;
  maxBytes?: number;
  maxTexto?: number;
}

/** Tamanho de um texto em UTF-8 sem alocar Buffer. */
function bytesUtf8(texto: string): number {
  let n = 0;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

interface EstadoPoda {
  truncou: boolean;
}

type Redigir = (texto: string) => string;
const SEM_REDACAO: Redigir = (texto) => texto;

function podar(valor: unknown, maxTexto: number, redigir: Redigir, estado: EstadoPoda): unknown {
  if (typeof valor === 'string') {
    const r = truncarTexto(redigir(valor), maxTexto);
    if (r.truncado) estado.truncou = true;
    return r.texto;
  }
  if (Array.isArray(valor)) return valor.map((v) => podar(v, maxTexto, redigir, estado));
  if (valor !== null && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) saida[k] = podar(v, maxTexto, redigir, estado);
    return saida;
  }
  return valor;
}

/**
 * Aplica redação + truncamento a `resumo` e a TODAS as strings de `dados`, e
 * garante `dados` ≤ `maxBytes` (encolhendo o teto de texto até caber). Se o
 * `dados` tem um campo booleano `truncado` (ex.: `agente.texto`), ele vira
 * `true` quando algo foi cortado. Não muda a forma do evento.
 */
export function enxugarEvento<E extends NovoEventoForja>(evento: E, opcoes: OpcoesEnxugar = {}): E {
  const redator = opcoes.redator ?? REDATOR_GENERICO;
  const maxBytes = opcoes.maxBytes ?? MAX_BYTES_PAYLOAD;
  let maxTexto = opcoes.maxTexto ?? MAX_TEXTO_PADRAO;
  const estado: EstadoPoda = { truncou: false };

  let dados = podar(evento.dados, maxTexto, (t) => redator.redigir(t), estado) as Record<
    string,
    unknown
  >;
  while (bytesUtf8(JSON.stringify(dados)) > maxBytes && maxTexto > 32) {
    maxTexto = Math.floor(maxTexto / 2);
    // Já redigido na 1ª passada; as seguintes só encolhem o teto de texto.
    dados = podar(dados, maxTexto, SEM_REDACAO, estado) as Record<string, unknown>;
  }
  if (estado.truncou && typeof dados.truncado === 'boolean') dados.truncado = true;

  return {
    ...evento,
    resumo: umaLinha(redator.redigir(evento.resumo), MAX_RESUMO),
    dados,
  } as E;
}
