import { StringDecoder } from 'node:string_decoder';
import type { PapelAgente, TurnoCondutor } from '../../comum/estados';
import { PapelAgente as PapeisAgente } from '../../comum/estados';
import type { AutoriaAgente, NivelEvento, NovoEventoForja } from '../../comum/protocolo-eventos';

/**
 * Parser do `--output-format stream-json` da CLI e normalizador para
 * `EventoForja` (specs/forja/01 §6.5; 04 §9).
 *
 * `stdout → divisor de linhas (sem limite de tamanho) → JSON.parse → normalizador`.
 * Uma linha que não é JSON gera alerta e não derruba o parser. O evento bruto
 * vai inteiro para `eventos.jsonl` (quem grava é o runner); aqui sai só o
 * recorte ENXUTO que o SQLite e o feed guardam (texto truncado, entradas de
 * ferramenta resumidas, 01 §8.2).
 *
 * Fatos observados na CLI 2.1.288 que este módulo respeita (fixtures reais em
 * `fixtures/*.jsonl`, pesquisa 01):
 * - `system/init` chega A CADA TURNO (não é sessão nova) e o runner valida todos;
 * - cada bloco de conteúdo vem numa mensagem `assistant` própria (mesmo `message.id`);
 * - um processo pode emitir VÁRIOS `result` (`result_index` 0, 1…): com subagente
 *   em background o primeiro vem sem `structured_output`. Vale o ÚLTIMO;
 * - falas e ferramentas de subagente trazem `parent_tool_use_id` = id do
 *   `tool_use` `Agent` que o lançou (árvore Fable → Opus no feed);
 * - em background, o `tool_result` do `Agent` é "Async agent launched" — a
 *   conclusão real é o `task_notification`. O checkpoint do implementador (F-08)
 *   dispara no que vier primeiro de: `tool_result` síncrono ou notificação.
 * - a ferramenta `Agent` aparece em `init.tools` como `Task`.
 */

// ---------------------------------------------------------------------------
// Formato da CLI (só o que o app lê; o resto fica no bruto)
// ---------------------------------------------------------------------------

export interface PluginInit {
  name: string;
  path?: string;
  source?: string;
}

export interface InitCli {
  type: 'system';
  subtype: 'init';
  session_id: string;
  claude_code_version?: string;
  permissionMode?: string;
  tools?: string[];
  mcp_servers?: { name: string; status?: string }[];
  apiKeySource?: string;
  agents?: string[];
  model?: string;
  plugins?: PluginInit[];
  capabilities?: string[];
  [chave: string]: unknown;
}

export interface NegacaoPermissao {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
}

export interface ResultCli {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  subagent_stats?: unknown;
  num_turns?: number;
  duration_ms?: number;
  permission_denials?: NegacaoPermissao[];
  terminal_reason?: string;
  result_index?: number;
  session_id?: string;
  [chave: string]: unknown;
}

export interface JanelaCota {
  utilization?: number;
  resetsAt?: number;
}

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, JanelaCota | undefined>;
  [chave: string]: unknown;
}

interface BlocoConteudo {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface MensagemCli {
  type: string;
  subtype?: string;
  [chave: string]: unknown;
}

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

/**
 * Divide o stdout em linhas sem limite de tamanho (uma linha do `result` passa
 * fácil de 100 KB) e sem quebrar um caractere UTF-8 partido entre dois chunks.
 */
export class DivisorLinhas {
  private readonly decoder = new StringDecoder('utf8');
  private resto = '';

  empurrar(chunk: Buffer | string): string[] {
    this.resto += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const partes = this.resto.split('\n');
    this.resto = partes.pop() ?? '';
    return partes.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }

  /** Fim do stream: devolve a última linha sem `\n`, se houver. */
  finalizar(): string[] {
    this.resto += this.decoder.end();
    const ultima = this.resto.trim();
    this.resto = '';
    return ultima ? [ultima] : [];
  }
}

export type LinhaAnalisada =
  { tipo: 'mensagem'; mensagem: MensagemCli } | { tipo: 'invalida'; linha: string; erro: string };

export function analisarLinha(linha: string): LinhaAnalisada {
  try {
    const valor: unknown = JSON.parse(linha);
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      const tipo = (valor as { type?: unknown }).type;
      if (typeof tipo === 'string') return { tipo: 'mensagem', mensagem: valor as MensagemCli };
    }
    return { tipo: 'invalida', linha, erro: 'JSON sem campo "type"' };
  } catch (e) {
    return { tipo: 'invalida', linha, erro: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Normalizador
// ---------------------------------------------------------------------------

export const LIMITE_TEXTO_FEED = 2000;
export const LIMITE_RESUMO = 200;

export function truncar(texto: string, max: number): { texto: string; truncado: boolean } {
  if (texto.length <= max) return { texto, truncado: false };
  return { texto: `${texto.slice(0, max - 1)}…`, truncado: true };
}

function umaLinha(texto: string, max = LIMITE_RESUMO): string {
  return truncar(texto.replace(/\s+/g, ' ').trim(), max).texto;
}

/** Texto da CLI ao bater o limite da assinatura (01 §6.6: "hit your … limit"). */
export const TEXTO_LIMITE_COTA = /hit your [^\n]{0,60}limit|usage limit reached/i;

/** `message.model` das mensagens que a CLI gera ela mesma (erros da API, aviso de limite). */
export const MODELO_SINTETICO = '<synthetic>';

/** Ferramentas cujo `tool_use` na thread principal do T1 é edição do condutor (04 §9). */
const FERRAMENTAS_EDICAO = new Set(['Edit', 'Write']);
const NOMES_AGENT = new Set(['Agent', 'Task']);

export interface ContextoNormalizador {
  execucaoId: string | null;
  etapaId: string | null;
  /** Papel da thread principal (`planejador`, `condutor`, `relator`). */
  papelPrincipal: PapelAgente;
  /** Só o T1 marca `agente.fora_do_papel`. */
  turno: TurnoCondutor | null;
}

export type SinalStream =
  | { tipo: 'init'; init: InitCli }
  | { tipo: 'result'; result: ResultCli }
  | { tipo: 'rate_limit'; info: RateLimitInfo }
  | { tipo: 'api_retry'; erro: string; tentativa: number | null; maxTentativas: number | null }
  /** Um `implementador` terminou (F-08). `emVoo` = implementadores ainda rodando. */
  | { tipo: 'implementador_retornou'; toolUseId: string; emVoo: number };

export interface SaidaNormalizada {
  eventos: NovoEventoForja[];
  sinais: SinalStream[];
}

/** Resumo de uma entrada de ferramenta em uma linha (nunca o conteúdo editado). */
export function resumirEntrada(
  ferramenta: string,
  entrada: Record<string, unknown> | undefined,
): string {
  const e = entrada ?? {};
  const s = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null);
  switch (ferramenta) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return umaLinha(s('file_path') ?? s('notebook_path') ?? '');
    case 'Bash':
      return umaLinha(s('command') ?? '');
    case 'Grep':
      return umaLinha(`${s('pattern') ?? ''}${s('path') ? ` em ${s('path')}` : ''}`);
    case 'Glob':
      return umaLinha(`${s('pattern') ?? ''}${s('path') ? ` em ${s('path')}` : ''}`);
    case 'Agent':
    case 'Task':
      return umaLinha(`${s('subagent_type') ?? '?'}: ${s('description') ?? ''}`);
    case 'StructuredOutput':
      return 'contrato entregue';
    default:
      return umaLinha(JSON.stringify(e));
  }
}

function textoDeConteudo(conteudo: unknown): string {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((c) =>
        c && typeof c === 'object' && typeof (c as BlocoConteudo).text === 'string'
          ? (c as BlocoConteudo).text
          : '',
      )
      .join('\n');
  }
  return '';
}

/** Negação que merece alerta vermelho (04 §9): tentativa de publicar ou de ler segredo. */
export function negacaoGrave(negacao: NegacaoPermissao): boolean {
  const entrada = negacao.tool_input ?? {};
  const comando = typeof entrada.command === 'string' ? entrada.command : '';
  const caminho = typeof entrada.file_path === 'string' ? entrada.file_path : '';
  return (
    /\bgit\s+(push|remote)\b/.test(comando) ||
    /(\.ssh\/|\.config\/gh\/|\.credentials\.json|(^|\/)\.env)/.test(`${caminho} ${comando}`)
  );
}

export class NormalizadorStream {
  private readonly subagentePorToolUse = new Map<string, string>();
  private readonly implementadoresEmVoo = new Set<string>();
  private readonly negacoesVistas = new Set<string>();
  private readonly resultados: ResultCli[] = [];
  private alertouMultiplos = false;
  private _textoLimiteCota = false;

  constructor(private readonly ctx: ContextoNormalizador) {}

  /** O último `result` do processo (maior `result_index`; empate = o que chegou depois). */
  get ultimoResult(): ResultCli | null {
    let melhor: ResultCli | null = null;
    for (const r of this.resultados) {
      if (!melhor || (r.result_index ?? 0) >= (melhor.result_index ?? 0)) melhor = r;
    }
    return melhor;
  }

  get totalResults(): number {
    return this.resultados.length;
  }

  /** Algum texto do stream disse "hit your … limit" (01 §6.6). */
  get textoLimiteCota(): boolean {
    return this._textoLimiteCota;
  }

  get implementadoresRodando(): number {
    return this.implementadoresEmVoo.size;
  }

  private evento<T extends NovoEventoForja['tipo']>(
    tipo: T,
    nivel: NivelEvento,
    resumo: string,
    dados: Extract<NovoEventoForja, { tipo: T }>['dados'],
  ): NovoEventoForja {
    return {
      execucao_id: this.ctx.execucaoId,
      etapa_id: this.ctx.etapaId,
      tipo,
      nivel,
      resumo: umaLinha(resumo, 300),
      dados,
    } as NovoEventoForja;
  }

  private autoria(parent: string | null): AutoriaAgente {
    if (!parent) return { papel_agente: this.ctx.papelPrincipal, parent_tool_use_id: null };
    const tipo = this.subagentePorToolUse.get(parent);
    const papel = tipo && tipo in PapeisAgente ? (tipo as PapelAgente) : null;
    return { papel_agente: papel, parent_tool_use_id: parent };
  }

  /** Linha que não é JSON: vai crua para o log (quem grava é o runner) e vira alerta (01 §6.5). */
  linhaInvalida(erro: string): SaidaNormalizada {
    return {
      eventos: [
        this.evento('cli.alerta', 'aviso', `Linha fora do formato no stream da CLI: ${erro}`, {
          codigo: 'linha_nao_json',
          bloqueante: false,
        }),
      ],
      sinais: [],
    };
  }

  processar(msg: MensagemCli): SaidaNormalizada {
    const saida: SaidaNormalizada = { eventos: [], sinais: [] };
    switch (msg.type) {
      case 'system':
        this.sistema(msg, saida);
        break;
      case 'assistant':
        this.assistente(msg, saida);
        break;
      case 'user':
        this.usuario(msg, saida);
        break;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info;
        if (info && typeof info === 'object')
          saida.sinais.push({ tipo: 'rate_limit', info: info as RateLimitInfo });
        break;
      }
      case 'result':
        this.resultado(msg as unknown as ResultCli, saida);
        break;
      default:
        break;
    }
    return saida;
  }

  private sistema(msg: MensagemCli, saida: SaidaNormalizada): void {
    switch (msg.subtype) {
      case 'init':
        saida.sinais.push({ tipo: 'init', init: msg as unknown as InitCli });
        break;
      case 'task_started': {
        const toolUseId = String(msg.tool_use_id ?? '');
        const subagente = String(
          msg.subagent_type ?? this.subagentePorToolUse.get(toolUseId) ?? '?',
        );
        if (toolUseId && !this.subagentePorToolUse.has(toolUseId)) {
          this.subagentePorToolUse.set(toolUseId, subagente);
        }
        const descricao = umaLinha(String(msg.description ?? ''));
        saida.eventos.push(
          this.evento(
            'subagente.iniciado',
            'info',
            `Subagente ${subagente} iniciado: ${descricao}`,
            {
              tool_use_id: toolUseId,
              subagente,
              descricao,
            },
          ),
        );
        break;
      }
      case 'task_notification': {
        const toolUseId = String(msg.tool_use_id ?? '');
        const subagente = this.subagentePorToolUse.get(toolUseId) ?? '?';
        const status = String(msg.status ?? 'desconhecido');
        const resumo = truncar(String(msg.summary ?? ''), 500).texto;
        saida.eventos.push(
          this.evento(
            'subagente.concluido',
            status === 'completed' ? 'info' : 'aviso',
            `Subagente ${subagente} terminou (${status})`,
            { tool_use_id: toolUseId, subagente, status, resumo, modelo: null },
          ),
        );
        this.fecharImplementador(toolUseId, saida);
        break;
      }
      case 'permission_denied':
        this.negacao(
          {
            tool_name: typeof msg.tool_name === 'string' ? msg.tool_name : undefined,
            tool_use_id: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
            tool_input:
              msg.tool_input && typeof msg.tool_input === 'object'
                ? (msg.tool_input as Record<string, unknown>)
                : undefined,
          },
          typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : null,
          saida,
        );
        break;
      case 'api_retry': {
        const erro = String(msg.error ?? 'desconhecido');
        const tentativa = typeof msg.attempt === 'number' ? msg.attempt : null;
        const maxTentativas = typeof msg.max_retries === 'number' ? msg.max_retries : null;
        saida.sinais.push({ tipo: 'api_retry', erro, tentativa, maxTentativas });
        const login = erro === 'authentication_failed';
        saida.eventos.push(
          this.evento(
            'cli.alerta',
            login ? 'erro' : 'aviso',
            login
              ? 'A CLI perdeu o login (authentication_failed): refaça o login no Terminal'
              : `A CLI está repetindo a chamada à API (${erro}, tentativa ${tentativa ?? '?'})`,
            { codigo: login ? 'login' : `api_retry_${erro}`, bloqueante: login },
          ),
        );
        break;
      }
      default:
        // thinking_tokens, background_tasks_changed, task_updated, hook_*: só no bruto.
        break;
    }
  }

  private assistente(msg: MensagemCli, saida: SaidaNormalizada): void {
    const parent = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : null;
    const mensagem = msg.message as { content?: BlocoConteudo[]; model?: unknown } | undefined;
    // Só a mensagem SINTÉTICA da própria CLI (o aviso de limite) na thread
    // principal conta como sinal de cota: texto do modelo que fale de "hit your
    // API limit" (um repo de rate limiting) não liga o freio global.
    const sintetica = mensagem?.model === MODELO_SINTETICO && parent === null;
    for (const bloco of mensagem?.content ?? []) {
      if (bloco.type === 'text' || bloco.type === 'thinking') {
        const bruto = (bloco.type === 'text' ? bloco.text : bloco.thinking) ?? '';
        if (!bruto.trim()) continue;
        if (sintetica && bloco.type === 'text' && TEXTO_LIMITE_COTA.test(bruto))
          this._textoLimiteCota = true;
        const { texto, truncado } = truncar(bruto, LIMITE_TEXTO_FEED);
        saida.eventos.push(
          this.evento('agente.texto', 'info', bruto, {
            ...this.autoria(parent),
            texto,
            truncado,
            pensamento: bloco.type === 'thinking',
          }),
        );
      } else if (bloco.type === 'tool_use') {
        this.usoFerramenta(bloco, parent, saida);
      }
    }
  }

  private usoFerramenta(
    bloco: BlocoConteudo,
    parent: string | null,
    saida: SaidaNormalizada,
  ): void {
    const nome = bloco.name ?? '?';
    const id = bloco.id ?? '';
    const resumoEntrada = resumirEntrada(nome, bloco.input);
    let subagente: string | null = null;
    if (NOMES_AGENT.has(nome)) {
      subagente = typeof bloco.input?.subagent_type === 'string' ? bloco.input.subagent_type : '?';
      if (id) this.subagentePorToolUse.set(id, subagente);
      if (subagente === 'implementador' && id) this.implementadoresEmVoo.add(id);
    }
    saida.eventos.push(
      this.evento('agente.ferramenta', 'info', `${nome}: ${resumoEntrada}`, {
        ...this.autoria(parent),
        tool_use_id: id,
        ferramenta: nome,
        resumo_entrada: resumoEntrada,
        subagente,
      }),
    );
    if (this.ctx.turno === 'T1' && parent === null && FERRAMENTAS_EDICAO.has(nome)) {
      saida.eventos.push(
        this.evento(
          'agente.fora_do_papel',
          'aviso',
          `O condutor editou diretamente: ${resumoEntrada}`,
          {
            ...this.autoria(null),
            ferramenta: nome as 'Edit' | 'Write',
            alvo: resumoEntrada,
          },
        ),
      );
    }
  }

  private usuario(msg: MensagemCli, saida: SaidaNormalizada): void {
    const parent = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : null;
    const mensagem = msg.message as { content?: unknown } | undefined;
    if (!Array.isArray(mensagem?.content)) return;
    const meta = msg.tool_use_result as { isAsync?: boolean; status?: string } | undefined;
    const assincrono = meta?.isAsync === true || meta?.status === 'async_launched';
    for (const bloco of mensagem.content as BlocoConteudo[]) {
      if (bloco.type !== 'tool_result') continue;
      const id = bloco.tool_use_id ?? '';
      const erro = bloco.is_error === true;
      const resumo = umaLinha(textoDeConteudo(bloco.content), 300);
      saida.eventos.push(
        this.evento(
          'agente.resultado_ferramenta',
          erro ? 'aviso' : 'info',
          `${erro ? 'Erro' : 'Resultado'}: ${resumo}`,
          { ...this.autoria(parent), tool_use_id: id, erro, resumo },
        ),
      );
      if (!assincrono) this.fecharImplementador(id, saida);
    }
  }

  private fecharImplementador(toolUseId: string, saida: SaidaNormalizada): void {
    if (!this.implementadoresEmVoo.delete(toolUseId)) return;
    saida.sinais.push({
      tipo: 'implementador_retornou',
      toolUseId,
      emVoo: this.implementadoresEmVoo.size,
    });
  }

  private negacao(neg: NegacaoPermissao, parent: string | null, saida: SaidaNormalizada): void {
    const chave = neg.tool_use_id ?? `${neg.tool_name}:${JSON.stringify(neg.tool_input ?? {})}`;
    if (this.negacoesVistas.has(chave)) return;
    this.negacoesVistas.add(chave);
    const ferramenta = neg.tool_name ?? '?';
    const resumoEntrada = resumirEntrada(ferramenta, neg.tool_input);
    saida.eventos.push(
      this.evento(
        'permissao.negada',
        negacaoGrave(neg) ? 'erro' : 'aviso',
        `Permissão negada: ${ferramenta} ${resumoEntrada}`,
        { ...this.autoria(parent), ferramenta, resumo_entrada: resumoEntrada },
      ),
    );
  }

  private resultado(result: ResultCli, saida: SaidaNormalizada): void {
    this.resultados.push(result);
    if (
      typeof result.result === 'string' &&
      result.is_error &&
      TEXTO_LIMITE_COTA.test(result.result)
    ) {
      this._textoLimiteCota = true;
    }
    for (const neg of result.permission_denials ?? []) this.negacao(neg, null, saida);
    if (this.resultados.length > 1 && !this.alertouMultiplos) {
      this.alertouMultiplos = true;
      saida.eventos.push(
        this.evento(
          'cli.alerta',
          'aviso',
          'A CLI emitiu mais de um result neste processo; vale o último',
          {
            codigo: 'multiplos_result',
            bloqueante: false,
          },
        ),
      );
    }
    saida.sinais.push({ tipo: 'result', result });
  }
}

/** Atalho: normaliza um stream inteiro (testes, smoke de perfis). */
export function normalizarStream(
  texto: string,
  ctx: ContextoNormalizador,
): {
  normalizador: NormalizadorStream;
  eventos: NovoEventoForja[];
  sinais: SinalStream[];
  invalidas: number;
} {
  const normalizador = new NormalizadorStream(ctx);
  const divisor = new DivisorLinhas();
  const eventos: NovoEventoForja[] = [];
  const sinais: SinalStream[] = [];
  let invalidas = 0;
  for (const linha of [...divisor.empurrar(texto), ...divisor.finalizar()]) {
    const analisada = analisarLinha(linha);
    const saida =
      analisada.tipo === 'mensagem'
        ? normalizador.processar(analisada.mensagem)
        : (invalidas++, normalizador.linhaInvalida(analisada.erro));
    eventos.push(...saida.eventos);
    sinais.push(...saida.sinais);
  }
  return { normalizador, eventos, sinais, invalidas };
}
