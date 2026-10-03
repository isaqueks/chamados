import { randomUUID } from 'node:crypto';
import type { TipoSessaoTerminal } from '../../comum/estados';
import type { ControleTerminalServidor } from '../../comum/dto';
import type { LocksSessao } from '../processos/lock-sessao';
import { ESCADA_PTY, type EscadaSinais } from '../processos/supervisor';
import {
  abrirPty,
  ambientePty,
  argsAssumir,
  argsLivre,
  type FabricaPty,
  type FimPty,
  type ParametrosAssumir,
  type ProcessoPty,
} from './pty';

/**
 * Registro das sessões de Terminal (specs/forja/01 §11, 06 §4.7, 03 §10).
 *
 * Uma SESSÃO é a aba (lógica, com id próprio = `sessao_terminal.id`); o
 * PROCESSO é o PTY que roda nela agora. Separados porque o processo sai
 * (`/exit`, crash, aba fechada) e a aba continua listada com [Reabrir] — que
 * na assumida é um novo `claude --resume` da MESMA `session_id`.
 *
 * Regras:
 * - **Lock por `session_id`** (01 §6.8): `assumir` adquire o lock da sessão da
 *   CLI com dono `terminal`; ele fica preso até `devolver` (06 §4.7: "a sessão
 *   continua com lock até devolver"), mesmo com o processo morto — o pipeline
 *   não pode rodar um `-p --resume` nela enquanto o humano não devolver.
 * - **1 processo por sessão**: `reabrir` só com o processo anterior morto.
 * - **Teto** de PTYs vivos (padrão 4, 01 §11).
 * - **Scrollback em anel** (≈ 1 MB) para reanexar depois de um reload; ao
 *   anexar, o cliente recebe `scrollback_inicio` → bytes → `scrollback_fim`.
 * - **Sem cliente, o PTY morre** depois de uma carência (05 §7.2: o PTY "só
 *   existe enquanto a aba está aberta"). A carência cobre o reload [NV S8].
 * - **Devolver** (01 §11): manda `/exit` à TUI, espera (timeout), depois a
 *   escada SIGHUP→SIGTERM→SIGKILL no grupo; libera o lock. O commit
 *   `forja: alterações manuais (#n)` e a volta a `verificando` são do
 *   orquestrador, que escuta o evento `devolvida`.
 *
 * - **Diálogo de confiança da pasta** [V S2 item 6]: numa worktree nova a TUI
 *   abre com "Accessing workspace… Yes, I trust this folder / No, exit" e o
 *   "No, exit" PRÉ-SELECIONADO (Enter sozinho encerra a TUI com código 1).
 *   Decisão: o app NÃO responde pelo humano. O diálogo é a única tela em que
 *   a CLI mostra permissões pré-aprovadas plantadas na pasta, recusa entrada
 *   nos primeiros instantes (anti-automação) e, aceito, grava a confiança
 *   daquele caminho em `~/.claude.json` — que a Forja não edita (não é
 *   mecanismo documentado para terceiros). O gerente DETECTA o diálogo na
 *   saída do PTY (evento `confianca_pasta`, uma vez por processo) e, se a TUI
 *   sair com código 1 depois dele, escreve no terminal como seguir
 *   (Reabrir → selecionar "Yes, I trust this folder" com as setas → Enter).
 *
 * Eventos (`aoEvento`) são o contrato com a R3: ela persiste `sessao_terminal`
 * (pid, aberta/encerrada, `sha_ao_devolver`) e move a execução
 * (`assumido_manual` ↔ `verificando`). Não são `EventoForja`: o catálogo do
 * envelope (01 §8.2) não tem tipo de terminal, e o estado da execução já sai
 * como `execucao.estado` pelo orquestrador.
 */

export const LIMITE_PTYS_PADRAO = 4;
export const SCROLLBACK_BYTES_PADRAO = 1024 * 1024;
export const CARENCIA_SEM_CLIENTE_MS = 30_000;
export const TIMEOUT_DEVOLVER_MS = 15_000;

/** Texto do diálogo de confiança da pasta da CLI (2.1.288), já sem ANSI. */
const DIALOGO_CONFIANCA = /trust this folder/i;
/** Janela de texto (sem ANSI) mantida para achar o diálogo partido entre pedaços. */
const JANELA_DETECCAO = 4096;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function semAnsi(texto: string): string {
  return texto.replace(ANSI, '');
}

/** Orientação escrita no terminal quando a TUI sai no diálogo de confiança. */
export const AVISO_CONFIANCA_RECUSADA =
  '\r\n\x1b[33m[Forja] A CLI encerrou no diálogo de confiança da pasta ' +
  '("No, exit" vem selecionado: Enter sozinho sai). Para continuar: Reabrir e, ' +
  'no diálogo, selecione "Yes, I trust this folder" com as setas e tecle Enter.\x1b[0m\r\n';

/** Últimos N bytes (UTF-8) da saída do PTY. Pode cortar no meio de uma sequência ANSI. */
export class ScrollbackPty {
  private pedacos: string[] = [];
  private inicio = 0;
  private bytes = 0;

  constructor(readonly capacidade: number = SCROLLBACK_BYTES_PADRAO) {}

  get tamanhoBytes(): number {
    return this.bytes;
  }

  acrescentar(dados: string): void {
    if (dados.length === 0) return;
    this.pedacos.push(dados);
    this.bytes += Buffer.byteLength(dados);
    while (this.bytes > this.capacidade && this.inicio < this.pedacos.length) {
      const primeiro = this.pedacos[this.inicio]!;
      const tam = Buffer.byteLength(primeiro);
      const excesso = this.bytes - this.capacidade;
      if (tam <= excesso) {
        this.inicio += 1;
        this.bytes -= tam;
      } else {
        const resto = Buffer.from(primeiro).subarray(excesso).toString('utf8');
        this.pedacos[this.inicio] = resto;
        this.bytes = this.bytes - tam + Buffer.byteLength(resto);
      }
    }
    if (this.inicio > 1024) {
      this.pedacos = this.pedacos.slice(this.inicio);
      this.inicio = 0;
    }
  }

  conteudo(): string {
    return this.pedacos.slice(this.inicio).join('');
  }
}

export interface InfoSessaoTerminal {
  id: string;
  tipo: TipoSessaoTerminal;
  titulo: string;
  cwd: string;
  execucao_id: string | null;
  etapa_id: string | null;
  session_id_claude: string | null;
  /** pid (= pgid = sid) do processo atual, se vivo. */
  pid: number | null;
  viva: boolean;
  aberta_em: string;
  encerrada_em: string | null;
  fim: FimPty | null;
  devolvida: boolean;
}

export type EventoSessaoTerminal =
  | { tipo: 'aberta'; sessao: InfoSessaoTerminal; reaberta: boolean }
  | {
      tipo: 'processo_saiu';
      sessao: InfoSessaoTerminal;
      fim: FimPty;
      /** A TUI saiu com código 1 depois de mostrar o diálogo de confiança da pasta. */
      confianca_recusada?: boolean;
    }
  /** A TUI mostrou o diálogo de confiança da pasta e espera o humano (uma vez por processo). */
  | { tipo: 'confianca_pasta'; sessao: InfoSessaoTerminal }
  | { tipo: 'devolvida'; sessao: InfoSessaoTerminal; forcado: boolean }
  | { tipo: 'fechada'; sessao: InfoSessaoTerminal };

/** Um WebSocket anexado (ou qualquer consumidor). */
export interface ClienteTerminal {
  enviarBytes(dados: string): void;
  enviarControle(mensagem: ControleTerminalServidor): void;
}

export class ErroTerminal extends Error {
  constructor(
    readonly codigo:
      | 'limite_ptys'
      | 'sessao_inexistente'
      | 'processo_vivo'
      | 'processo_morto'
      | 'nao_assumida'
      | 'assumida_nao_devolvida'
      | 'ja_devolvida',
    mensagem: string,
  ) {
    super(mensagem);
  }
}

export interface DepsGerenteTerminal {
  locks: LocksSessao;
  fabrica?: FabricaPty;
  comandoClaude?: string;
  limite?: number;
  capacidadeScrollback?: number;
  carenciaSemClienteMs?: number;
  escada?: EscadaSinais;
  ambienteOrigem?: Readonly<Record<string, string | undefined>>;
  agora?: () => Date;
  gerarId?: () => string;
  aoEvento?: (evento: EventoSessaoTerminal) => void;
}

export interface OpcoesAbrirLivre {
  cwd: string;
  titulo: string;
  execucao_id?: string | null;
  colunas?: number;
  linhas?: number;
}

export interface OpcoesAssumir extends ParametrosAssumir {
  cwd: string;
  titulo: string;
  execucao_id: string;
  etapa_id: string;
  colunas?: number;
  linhas?: number;
}

interface Sessao {
  id: string;
  tipo: TipoSessaoTerminal;
  titulo: string;
  cwd: string;
  execucao_id: string | null;
  etapa_id: string | null;
  session_id_claude: string | null;
  assumir: ParametrosAssumir | null;
  processo: ProcessoPty | null;
  saida: Promise<FimPty> | null;
  aberta_em: string;
  encerrada_em: string | null;
  fim: FimPty | null;
  devolvida: boolean;
  scrollback: ScrollbackPty;
  clientes: Set<ClienteTerminal>;
  carencia: NodeJS.Timeout | null;
  colunas: number | undefined;
  linhas: number | undefined;
}

/** Temporizador que não segura o processo vivo (o PTY já segura enquanto existir). */
const dormir = (ms: number): Promise<'tempo'> =>
  new Promise((r) => setTimeout(() => r('tempo'), ms).unref());

export class GerenteSessoesTerminal {
  private readonly sessoes = new Map<string, Sessao>();
  private readonly fabrica: FabricaPty;
  private readonly agora: () => Date;
  private readonly gerarId: () => string;
  readonly limite: number;

  constructor(private readonly deps: DepsGerenteTerminal) {
    this.fabrica = deps.fabrica ?? abrirPty;
    this.agora = deps.agora ?? (() => new Date());
    this.gerarId = deps.gerarId ?? randomUUID;
    this.limite = deps.limite ?? LIMITE_PTYS_PADRAO;
  }

  listar(): InfoSessaoTerminal[] {
    return [...this.sessoes.values()].map((s) => this.info(s));
  }

  obter(id: string): InfoSessaoTerminal | null {
    const s = this.sessoes.get(id);
    return s ? this.info(s) : null;
  }

  /** Sessões (`sid` = pid do PTY) que a varredura de sobras do supervisor nunca toca. */
  sessoesProtegidas(): Set<number> {
    const pids = new Set<number>();
    for (const s of this.sessoes.values()) if (s.processo && !s.fim) pids.add(s.processo.pid);
    return pids;
  }

  get vivas(): number {
    let n = 0;
    for (const s of this.sessoes.values()) if (s.processo && !s.fim) n += 1;
    return n;
  }

  abrirLivre(opcoes: OpcoesAbrirLivre): InfoSessaoTerminal {
    this.conferirLimite();
    const sessao = this.novaSessao({
      tipo: 'livre',
      titulo: opcoes.titulo,
      cwd: opcoes.cwd,
      execucao_id: opcoes.execucao_id ?? null,
      etapa_id: null,
      session_id_claude: null,
      assumir: null,
      colunas: opcoes.colunas,
      linhas: opcoes.linhas,
    });
    this.iniciarProcesso(sessao, false);
    return this.info(sessao);
  }

  /**
   * Assumir (03 §10): lock da `session_id` com dono `terminal` ANTES do spawn;
   * se o lock está com uma etapa (o turno ainda não saiu), lança
   * `ErroSessaoOcupada` — quem chama pausa a etapa primeiro.
   */
  assumir(opcoes: OpcoesAssumir): InfoSessaoTerminal {
    this.conferirLimite();
    const assumir: ParametrosAssumir = {
      session_id: opcoes.session_id,
      settings: opcoes.settings,
      modelo: opcoes.modelo,
    };
    argsAssumir(assumir); // valida antes de prender o lock
    const id = this.gerarId();
    this.deps.locks.adquirir(opcoes.session_id, { tipo: 'terminal', sessao_terminal_id: id });
    const sessao = this.novaSessao({
      id,
      tipo: 'assumida',
      titulo: opcoes.titulo,
      cwd: opcoes.cwd,
      execucao_id: opcoes.execucao_id,
      etapa_id: opcoes.etapa_id,
      session_id_claude: opcoes.session_id,
      assumir,
      colunas: opcoes.colunas,
      linhas: opcoes.linhas,
    });
    try {
      this.iniciarProcesso(sessao, false);
    } catch (erro) {
      this.sessoes.delete(id);
      this.deps.locks.liberar(opcoes.session_id, { tipo: 'terminal', sessao_terminal_id: id });
      throw erro;
    }
    return this.info(sessao);
  }

  /** [Reabrir] (06 §4.7): novo processo na mesma aba; na assumida, `--resume` de novo. */
  reabrir(id: string): InfoSessaoTerminal {
    const sessao = this.exigir(id);
    if (sessao.processo && !sessao.fim) {
      throw new ErroTerminal('processo_vivo', 'o processo desta aba ainda está rodando');
    }
    if (sessao.devolvida) {
      throw new ErroTerminal('ja_devolvida', 'a sessão já foi devolvida ao pipeline');
    }
    this.conferirLimite();
    this.iniciarProcesso(sessao, true);
    return this.info(sessao);
  }

  escrever(id: string, dados: string): void {
    const s = this.sessoes.get(id);
    if (s?.processo && !s.fim) s.processo.escrever(dados);
  }

  redimensionar(id: string, colunas: number, linhas: number): void {
    const s = this.sessoes.get(id);
    if (!s) return;
    s.colunas = colunas;
    s.linhas = linhas;
    if (s.processo && !s.fim) s.processo.redimensionar(colunas, linhas);
  }

  /**
   * Anexa um cliente: scrollback primeiro, depois ao vivo. Se o processo já
   * saiu, manda também `encerrado`. Devolve o desanexar.
   */
  anexar(id: string, cliente: ClienteTerminal): () => void {
    const sessao = this.exigir(id);
    if (sessao.carencia) {
      clearTimeout(sessao.carencia);
      sessao.carencia = null;
    }
    cliente.enviarControle({ tipo: 'scrollback_inicio' });
    const anterior = sessao.scrollback.conteudo();
    if (anterior) cliente.enviarBytes(anterior);
    cliente.enviarControle({ tipo: 'scrollback_fim' });
    if (sessao.fim) {
      cliente.enviarControle({
        tipo: 'encerrado',
        codigo: sessao.fim.codigo,
        sinal: sessao.fim.sinal,
      });
    }
    sessao.clientes.add(cliente);
    return () => {
      if (!sessao.clientes.delete(cliente)) return;
      if (sessao.clientes.size === 0) this.armarCarencia(sessao);
    };
  }

  /** Encerra o processo (escada PTY). A aba fica listada; a assumida mantém o lock. */
  async encerrar(id: string): Promise<FimPty | null> {
    const sessao = this.exigir(id);
    return this.pararProcesso(sessao);
  }

  /**
   * Devolver ao pipeline (01 §11): `/exit` → espera → escada; libera o lock.
   * `forcado` = a TUI não saiu sozinha no prazo [NV S8].
   */
  async devolver(
    id: string,
    opcoes: { timeoutMs?: number } = {},
  ): Promise<{ forcado: boolean; fim: FimPty | null }> {
    const sessao = this.exigir(id);
    if (sessao.tipo !== 'assumida' || !sessao.session_id_claude) {
      throw new ErroTerminal('nao_assumida', 'só uma sessão assumida pode ser devolvida');
    }
    if (sessao.devolvida) throw new ErroTerminal('ja_devolvida', 'a sessão já foi devolvida');
    let forcado = false;
    if (sessao.processo && !sessao.fim && sessao.saida) {
      sessao.processo.escrever('/exit\r');
      const r = await Promise.race([sessao.saida, dormir(opcoes.timeoutMs ?? TIMEOUT_DEVOLVER_MS)]);
      if (r === 'tempo') {
        forcado = true;
        await this.pararProcesso(sessao);
      }
    }
    sessao.devolvida = true;
    this.deps.locks.liberar(sessao.session_id_claude, {
      tipo: 'terminal',
      sessao_terminal_id: sessao.id,
    });
    this.emitir({ tipo: 'devolvida', sessao: this.info(sessao), forcado });
    return { forcado, fim: sessao.fim };
  }

  /**
   * Remove a aba. Livre: encerra e some. Assumida não devolvida: só com
   * `liberarLock` (descartar/cancelar a execução) — senão o lock ficaria preso
   * a uma aba que não existe mais.
   */
  async fechar(id: string, opcoes: { liberarLock?: boolean } = {}): Promise<void> {
    const sessao = this.exigir(id);
    if (sessao.tipo === 'assumida' && !sessao.devolvida && !opcoes.liberarLock) {
      throw new ErroTerminal(
        'assumida_nao_devolvida',
        'devolva a sessão (ou descarte a execução) antes de fechar a aba assumida',
      );
    }
    await this.pararProcesso(sessao);
    if (sessao.tipo === 'assumida' && !sessao.devolvida && sessao.session_id_claude) {
      this.deps.locks.liberar(sessao.session_id_claude, {
        tipo: 'terminal',
        sessao_terminal_id: sessao.id,
      });
    }
    this.sessoes.delete(id);
    this.emitir({ tipo: 'fechada', sessao: this.info(sessao) });
  }

  /** Desligamento do app: escada em todos os PTYs vivos, em paralelo. Locks ficam (boot reconcilia). */
  async encerrarTodas(): Promise<void> {
    await Promise.all([...this.sessoes.values()].map((s) => this.pararProcesso(s)));
  }

  // --- internos ---

  private conferirLimite(): void {
    if (this.vivas >= this.limite) {
      throw new ErroTerminal(
        'limite_ptys',
        `limite de ${this.limite} terminais abertos; feche uma aba para abrir outra`,
      );
    }
  }

  private exigir(id: string): Sessao {
    const s = this.sessoes.get(id);
    if (!s) throw new ErroTerminal('sessao_inexistente', `sessão de terminal inexistente: ${id}`);
    return s;
  }

  private novaSessao(
    base: Omit<
      Sessao,
      | 'id'
      | 'processo'
      | 'saida'
      | 'aberta_em'
      | 'encerrada_em'
      | 'fim'
      | 'devolvida'
      | 'scrollback'
      | 'clientes'
      | 'carencia'
    > & { id?: string },
  ): Sessao {
    const sessao: Sessao = {
      ...base,
      id: base.id ?? this.gerarId(),
      processo: null,
      saida: null,
      aberta_em: this.agora().toISOString(),
      encerrada_em: null,
      fim: null,
      devolvida: false,
      scrollback: new ScrollbackPty(this.deps.capacidadeScrollback),
      clientes: new Set(),
      carencia: null,
    };
    this.sessoes.set(sessao.id, sessao);
    return sessao;
  }

  private iniciarProcesso(sessao: Sessao, reaberta: boolean): void {
    const assumida = sessao.tipo === 'assumida';
    const processo = this.fabrica({
      comando: this.deps.comandoClaude ?? 'claude',
      args: assumida ? argsAssumir(sessao.assumir!) : argsLivre(),
      cwd: sessao.cwd,
      env: ambientePty({ assumida, origem: this.deps.ambienteOrigem }),
      colunas: sessao.colunas,
      linhas: sessao.linhas,
    });
    sessao.processo = processo;
    sessao.fim = null;
    sessao.encerrada_em = null;
    let janela = '';
    let confiancaPedida = false;
    processo.aoDados((dados) => {
      if (!confiancaPedida && sessao.processo === processo) {
        janela = (janela + semAnsi(dados)).slice(-JANELA_DETECCAO);
        if (DIALOGO_CONFIANCA.test(janela)) {
          confiancaPedida = true;
          janela = '';
          this.emitir({ tipo: 'confianca_pasta', sessao: this.info(sessao) });
        }
      }
      sessao.scrollback.acrescentar(dados);
      for (const c of sessao.clientes) {
        try {
          c.enviarBytes(dados);
        } catch {
          // cliente quebrado não interrompe os outros nem o PTY
        }
      }
    });
    sessao.saida = new Promise<FimPty>((resolve) => {
      processo.aoSair((fim) => {
        if (sessao.processo !== processo) return resolve(fim);
        sessao.fim = fim;
        sessao.encerrada_em = this.agora().toISOString();
        if (sessao.carencia) {
          clearTimeout(sessao.carencia);
          sessao.carencia = null;
        }
        const confiancaRecusada = confiancaPedida && fim.codigo === 1;
        if (confiancaRecusada) {
          // Depois que a TUI saiu o terminal é texto puro: o aviso não corrompe tela nenhuma.
          sessao.scrollback.acrescentar(AVISO_CONFIANCA_RECUSADA);
          for (const c of sessao.clientes) {
            try {
              c.enviarBytes(AVISO_CONFIANCA_RECUSADA);
            } catch {
              // idem
            }
          }
        }
        for (const c of sessao.clientes) {
          try {
            c.enviarControle({ tipo: 'encerrado', codigo: fim.codigo, sinal: fim.sinal });
          } catch {
            // idem
          }
        }
        this.emitir({
          tipo: 'processo_saiu',
          sessao: this.info(sessao),
          fim,
          ...(confiancaRecusada ? { confianca_recusada: true } : {}),
        });
        resolve(fim);
      });
    });
    this.emitir({ tipo: 'aberta', sessao: this.info(sessao), reaberta });
    if (sessao.clientes.size === 0) this.armarCarencia(sessao);
  }

  private armarCarencia(sessao: Sessao): void {
    if (!sessao.processo || sessao.fim) return;
    if (sessao.carencia) clearTimeout(sessao.carencia);
    const ms = this.deps.carenciaSemClienteMs ?? CARENCIA_SEM_CLIENTE_MS;
    sessao.carencia = setTimeout(() => {
      sessao.carencia = null;
      if (sessao.clientes.size === 0) void this.pararProcesso(sessao);
    }, ms);
    sessao.carencia.unref();
  }

  private async pararProcesso(sessao: Sessao): Promise<FimPty | null> {
    if (sessao.carencia) {
      clearTimeout(sessao.carencia);
      sessao.carencia = null;
    }
    const { processo, saida } = sessao;
    if (!processo || !saida || sessao.fim) return sessao.fim;
    for (const passo of this.deps.escada ?? ESCADA_PTY) {
      processo.sinalizar(passo.sinal);
      const r = await Promise.race([saida, dormir(passo.esperaMs)]);
      if (r !== 'tempo') return r;
    }
    return sessao.fim;
  }

  private info(s: Sessao): InfoSessaoTerminal {
    const viva = Boolean(s.processo && !s.fim);
    return {
      id: s.id,
      tipo: s.tipo,
      titulo: s.titulo,
      cwd: s.cwd,
      execucao_id: s.execucao_id,
      etapa_id: s.etapa_id,
      session_id_claude: s.session_id_claude,
      pid: viva ? s.processo!.pid : null,
      viva,
      aberta_em: s.aberta_em,
      encerrada_em: s.encerrada_em,
      fim: s.fim,
      devolvida: s.devolvida,
    };
  }

  private emitir(evento: EventoSessaoTerminal): void {
    try {
      this.deps.aoEvento?.(evento);
    } catch {
      // ouvinte com defeito não derruba o terminal
    }
  }
}
