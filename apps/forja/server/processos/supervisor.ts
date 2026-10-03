import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { TipoEtapa } from '../../comum/estados';
import {
  grupoVivo as grupoVivoReal,
  leitorProcLinux,
  processosNaRaiz,
  sondarProcesso,
  type EstadoSondado,
  type LeitorProc,
} from './proc-linux';

/**
 * Supervisor de processos (specs/forja/01 §3.2): a base ÚNICA por onde nascem
 * os filhos da CLI (`claude -p`), da verificação (`/bin/sh -c`) e do git longo.
 *
 * POR QUE cada regra:
 * - **Grupo próprio** (`detached: true` ⇒ `setsid`, `pgid = pid`): o `claude`
 *   dispara Bash, subagentes e às vezes dev servers. Sinal só para o pid deixa
 *   netos órfãos editando a worktree; todo sinal vai para `-pgid` (01 §13.5).
 * - **Escada** SIGINT → 10 s → SIGTERM → 10 s → SIGKILL: SIGINT encerra o turno
 *   com registro (a sessão continua retomável, 03 §10); SIGTERM faz a CLI matar a
 *   árvore do Bash (01 §2.3 [V]); SIGKILL é o último recurso. Depois, a varredura
 *   de `/proc/*\/cwd` na worktree mata quem escapou do grupo [NV → S4].
 * - **Registro logo após o spawn**: `pid`/`pgid` chegam ao `RegistroProcessos`
 *   (a R3 grava em `etapa.pid/pgid`, 02 §4.7) ANTES de qualquer byte do stream
 *   ser consumido — é o que a reconciliação do boot lê depois de um crash.
 *   Falhar ao registrar mata o filho: processo sem registro é órfão garantido.
 * - **Timeout** da etapa dispara a escada; **silêncio** (sem evento no stream
 *   por 15 min) só AVISA, nunca mata — um build longo não emite evento.
 * - O supervisor nunca lê o stdout: entrega os streams a quem consome (runner
 *   da CLI, runner de verificação), que nunca pode bloquear (01 §8.1).
 */

export interface PassoEscada {
  sinal: NodeJS.Signals;
  /** Quanto esperar o grupo esvaziar depois deste sinal. */
  esperaMs: number;
}
export type EscadaSinais = readonly PassoEscada[];

/** 01 §3.2 / 03 §11: SIGINT → 10 s → SIGTERM → 10 s → SIGKILL. */
export const ESCADA_PADRAO: EscadaSinais = [
  { sinal: 'SIGINT', esperaMs: 10_000 },
  { sinal: 'SIGTERM', esperaMs: 10_000 },
  { sinal: 'SIGKILL', esperaMs: 5_000 },
];

/** Sobras de um grupo cujo líder já saiu sozinho: sem turno a encerrar com registro. */
export const ESCADA_SOBRAS: EscadaSinais = [
  { sinal: 'SIGTERM', esperaMs: 2_000 },
  { sinal: 'SIGKILL', esperaMs: 2_000 },
];

/**
 * PTY (01 §11): SIGHUP é o "terminal fechou" que a TUI entende; depois a mesma
 * subida. Usada no Devolver (após `/exit` + timeout) e nos PTYs órfãos do boot.
 */
export const ESCADA_PTY: EscadaSinais = [
  { sinal: 'SIGHUP', esperaMs: 3_000 },
  { sinal: 'SIGTERM', esperaMs: 3_000 },
  { sinal: 'SIGKILL', esperaMs: 2_000 },
];

/** Resolve o nome usado nas ações de reconciliação (`encerrar_grupo.escada`). */
export function escadaPorNome(nome: 'padrao' | 'pty'): EscadaSinais {
  return nome === 'pty' ? ESCADA_PTY : ESCADA_PADRAO;
}

/** Timeouts por etapa (01 §3.2; configuráveis). As ausentes não têm teto padrão. */
export const TIMEOUTS_PADRAO_MS: Readonly<Partial<Record<TipoEtapa, number>>> = {
  planejar: 15 * 60_000,
  implementar: 90 * 60_000,
  resolver_conflito: 90 * 60_000,
  revisar: 45 * 60_000,
  relatar: 5 * 60_000,
  conversar: 15 * 60_000,
};

/** Sem evento no stream por 15 min → aviso "possivelmente travado" (02 §4.7). */
export const AVISO_SILENCIO_PADRAO_MS = 15 * 60_000;

export interface ResultadoEscada {
  /** O grupo ficou vazio? (false = sobreviveu até ao SIGKILL — anômalo.) */
  encerrado: boolean;
  sinais: NodeJS.Signals[];
  duracao_ms: number;
}

export interface DepsEscada {
  grupoVivo?: (pgid: number) => boolean;
  /** Envia `sinal` ao grupo; ESRCH é silencioso. */
  sinalizarGrupo?: (pgid: number, sinal: NodeJS.Signals) => void;
  intervaloMs?: number;
}

export function sinalizarGrupoReal(pgid: number, sinal: NodeJS.Signals): void {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`pgid inválido para sinalizar: ${pgid}`);
  }
  try {
    process.kill(-pgid, sinal);
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code !== 'ESRCH') throw erro;
  }
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Aplica a escada no GRUPO (`-pgid`) até ele esvaziar. Para no primeiro degrau
 * em que o grupo some; um grupo já vazio não recebe sinal nenhum.
 */
export async function encerrarGrupo(
  pgid: number,
  escada: EscadaSinais = ESCADA_PADRAO,
  deps: DepsEscada = {},
): Promise<ResultadoEscada> {
  const vivo = deps.grupoVivo ?? grupoVivoReal;
  const sinalizar = deps.sinalizarGrupo ?? sinalizarGrupoReal;
  const intervalo = deps.intervaloMs ?? 50;
  const inicio = Date.now();
  const sinais: NodeJS.Signals[] = [];
  for (const passo of escada) {
    if (!vivo(pgid)) return { encerrado: true, sinais, duracao_ms: Date.now() - inicio };
    sinalizar(pgid, passo.sinal);
    sinais.push(passo.sinal);
    const limite = Date.now() + passo.esperaMs;
    while (Date.now() < limite) {
      await dormir(Math.min(intervalo, Math.max(1, limite - Date.now())));
      if (!vivo(pgid)) return { encerrado: true, sinais, duracao_ms: Date.now() - inicio };
    }
  }
  return { encerrado: !vivo(pgid), sinais, duracao_ms: Date.now() - inicio };
}

// ---------------------------------------------------------------------------
// Registro (persistência é da R3: `etapa.pid/pgid`, `sessao_terminal.pid/pgid`)
// ---------------------------------------------------------------------------

export interface ProcessoRegistrado {
  pid: number;
  pgid: number;
  etapa_id: string | null;
  /** ISO-8601 do spawn. */
  inicio: string;
  /** Ex.: `claude:implementar`, `verificacao:typecheck`, `git:push`. */
  rotulo: string;
  /** argv[0] esperado na reconciliação (`claude`, `sh`, `git`). */
  comando: string;
}

/** Como o processo terminou, do ponto de vista de QUEM PEDIU (base de 01 §6.6). */
export type MotivoFimProcesso =
  'natural' | 'pausado' | 'cancelado' | 'timeout' | 'encerramento_app' | 'erro_registro';

export interface FimProcesso {
  exit_code: number | null;
  sinal: NodeJS.Signals | null;
  motivo: MotivoFimProcesso;
  duracao_ms: number;
  /** Escada aplicada (cancelamento, timeout, sobras do grupo). */
  escada: ResultadoEscada | null;
  /** Pids mortos pela varredura de cwd depois da escada. */
  sobras_mortas: number[];
}

/**
 * Persistência do registro (02 §4.7). SÍNCRONA de propósito: better-sqlite3 é
 * síncrono e o `pid` precisa estar gravado antes de o stream ser consumido.
 */
export interface RegistroProcessos {
  aoIniciar(processo: ProcessoRegistrado): void;
  aoTerminar(processo: ProcessoRegistrado, fim: FimProcesso): void;
}

/** Registro em memória (testes e boot sem banco). */
export class RegistroProcessosMemoria implements RegistroProcessos {
  readonly ativos = new Map<number, ProcessoRegistrado>();
  readonly encerrados: { processo: ProcessoRegistrado; fim: FimProcesso }[] = [];
  aoIniciar(processo: ProcessoRegistrado): void {
    this.ativos.set(processo.pid, processo);
  }
  aoTerminar(processo: ProcessoRegistrado, fim: FimProcesso): void {
    this.ativos.delete(processo.pid);
    this.encerrados.push({ processo, fim });
  }
}

// ---------------------------------------------------------------------------
// Processo supervisionado
// ---------------------------------------------------------------------------

export interface OpcoesProcesso {
  comando: string;
  args: readonly string[];
  cwd: string;
  /** Ambiente COMPLETO do filho (allowlist já montada: `montarAmbiente`). */
  env: Readonly<Record<string, string>>;
  rotulo: string;
  etapa_id?: string | null;
  /** argv[0] esperado na reconciliação; padrão = basename de `comando`. */
  comandoEsperado?: string;
  /** Escrito no stdin, que é FECHADO em seguida (01 §6.1). Ausente = stdin ignorado. */
  entrada?: string | Buffer;
  /** null = sem timeout. */
  timeoutMs?: number | null;
  /** null = sem aviso de silêncio. Padrão: 15 min. */
  avisoSilencioMs?: number | null;
  aoSilencio?: (processo: ProcessoSupervisionado, silencioMs: number) => void;
  /** Escada do cancelamento e do timeout. Padrão: `ESCADA_PADRAO`. */
  escada?: EscadaSinais;
  /** Worktree: depois da escada, mata quem tiver `cwd` dentro dela. */
  raizVarredura?: string | null;
}

export class ErroSpawn extends Error {
  constructor(
    mensagem: string,
    readonly codigo: string | undefined,
  ) {
    super(mensagem);
  }
}

export interface DepsSupervisor {
  registro?: RegistroProcessos;
  leitorProc?: LeitorProc;
  escada?: DepsEscada;
  /** Sessões de PTY abertas: a varredura de cwd nunca as toca (01 §11). */
  sessoesProtegidas?: () => Iterable<number>;
  agora?: () => Date;
  /** Quanto esperar o `close` dos pipes depois do `exit` (neto segurando o stdout). */
  graceFechamentoMs?: number;
}

export class ProcessoSupervisionado {
  readonly pid: number;
  readonly pgid: number;
  readonly registro: ProcessoRegistrado;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly fim: Promise<FimProcesso>;

  private motivoPedido: MotivoFimProcesso | null = null;
  private escadaEmCurso: Promise<ResultadoEscada> | null = null;
  private ultimaAtividade = Date.now();
  private avisou = false;
  private temporizadorSilencio: NodeJS.Timeout | null = null;
  private temporizadorTimeout: NodeJS.Timeout | null = null;
  private terminado = false;
  private readonly fechou: Promise<void>;

  /** @internal Construído só por `Supervisor.iniciar`. */
  constructor(
    private readonly filho: ChildProcess,
    registro: ProcessoRegistrado,
    private readonly opcoes: OpcoesProcesso,
    private readonly sup: Supervisor,
  ) {
    this.pid = registro.pid;
    this.pgid = registro.pgid;
    this.registro = registro;
    this.stdout = filho.stdout!;
    this.stderr = filho.stderr!;
    // Escutado já na construção: o `close` pode vir antes de a escada terminar.
    this.fechou = new Promise((resolve) => filho.once('close', () => resolve()));
    this.fim = this.acompanhar();
    this.armarTimers();
  }

  get encerrado(): boolean {
    return this.terminado;
  }

  /** O consumidor do stream chama a cada evento: zera o relógio do aviso de silêncio. */
  registrarAtividade(): void {
    this.ultimaAtividade = Date.now();
    if (this.avisou) {
      this.avisou = false;
      this.armarSilencio(this.opcoes.avisoSilencioMs ?? AVISO_SILENCIO_PADRAO_MS);
    }
  }

  /** Pausar (03 §10): SIGINT no grupo, sem escada. O turno encerra com registro. */
  pausar(): void {
    if (this.terminado) return;
    this.motivoPedido ??= 'pausado';
    this.sup.sinalizar(this.pgid, 'SIGINT');
  }

  /** Cancelar: escada completa no grupo + varredura. Resolve com o fim do processo. */
  cancelar(escada?: EscadaSinais): Promise<FimProcesso> {
    this.motivoPedido = this.motivoPedido === 'timeout' ? 'timeout' : 'cancelado';
    this.iniciarEscada(escada);
    return this.fim;
  }

  /** @internal Desligamento do app (01 §3.2). */
  encerrarPorDesligamento(escada?: EscadaSinais): Promise<FimProcesso> {
    this.motivoPedido ??= 'encerramento_app';
    this.iniciarEscada(escada);
    return this.fim;
  }

  /** @internal */
  marcarErroRegistro(): void {
    this.motivoPedido = 'erro_registro';
  }

  private iniciarEscada(escada?: EscadaSinais): Promise<ResultadoEscada> {
    this.escadaEmCurso ??= this.sup.aplicarEscada(
      this.pgid,
      escada ?? this.opcoes.escada ?? ESCADA_PADRAO,
    );
    return this.escadaEmCurso;
  }

  private armarTimers(): void {
    const timeout = this.opcoes.timeoutMs;
    if (timeout != null && timeout > 0) {
      this.temporizadorTimeout = setTimeout(() => {
        if (this.terminado) return;
        this.motivoPedido = 'timeout';
        this.iniciarEscada();
      }, timeout);
    }
    const silencio =
      this.opcoes.avisoSilencioMs === undefined
        ? AVISO_SILENCIO_PADRAO_MS
        : this.opcoes.avisoSilencioMs;
    if (silencio != null && silencio > 0) this.armarSilencio(silencio);
  }

  private armarSilencio(limiteMs: number): void {
    if (this.terminado) return;
    if (this.temporizadorSilencio) clearTimeout(this.temporizadorSilencio);
    const restante = Math.max(1, this.ultimaAtividade + limiteMs - Date.now());
    this.temporizadorSilencio = setTimeout(() => {
      if (this.terminado) return;
      const silencio = Date.now() - this.ultimaAtividade;
      if (silencio >= limiteMs) {
        this.avisou = true;
        try {
          this.opcoes.aoSilencio?.(this, silencio);
        } catch {
          // Aviso com defeito não derruba o supervisor.
        }
      } else {
        this.armarSilencio(limiteMs);
      }
    }, restante);
    this.temporizadorSilencio.unref();
  }

  private async acompanhar(): Promise<FimProcesso> {
    const inicio = Date.now();
    const saida = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        this.filho.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    if (this.temporizadorTimeout) clearTimeout(this.temporizadorTimeout);
    if (this.temporizadorSilencio) clearTimeout(this.temporizadorSilencio);

    // Escada pedida ainda subindo os degraus: espera terminar (netos no grupo).
    let escada = this.escadaEmCurso ? await this.escadaEmCurso : null;
    // Líder saiu sozinho mas o grupo tem sobras: ninguém de antes sobrevive sem dono.
    if (!escada && this.sup.grupoTemMembros(this.pgid)) {
      escada = await this.sup.aplicarEscada(this.pgid, ESCADA_SOBRAS);
    }
    const sobras = this.opcoes.raizVarredura
      ? await this.sup.varrerSobras(this.opcoes.raizVarredura)
      : [];
    await this.sup.aguardarFechamento(this.filho, this.fechou);

    this.terminado = true;
    return {
      exit_code: saida.code,
      sinal: saida.signal,
      motivo: this.motivoPedido ?? 'natural',
      duracao_ms: Date.now() - inicio,
      escada,
      sobras_mortas: sobras,
    };
  }
}

export interface ResultadoOrfao {
  processo: ProcessoRegistrado;
  estado: EstadoSondado;
  escada: ResultadoEscada | null;
}

export class Supervisor {
  private readonly ativosPorPid = new Map<number, ProcessoSupervisionado>();
  private readonly registro: RegistroProcessos;
  private readonly leitor: LeitorProc;
  private readonly agora: () => Date;
  private aceitando = true;

  constructor(private readonly deps: DepsSupervisor = {}) {
    this.registro = deps.registro ?? new RegistroProcessosMemoria();
    this.leitor = deps.leitorProc ?? leitorProcLinux;
    this.agora = deps.agora ?? (() => new Date());
  }

  /** Processos vivos sob supervisão (para o desligamento e o Diagnóstico). */
  ativos(): ProcessoRegistrado[] {
    return [...this.ativosPorPid.values()].map((p) => p.registro);
  }

  obter(pid: number): ProcessoSupervisionado | undefined {
    return this.ativosPorPid.get(pid);
  }

  /**
   * Spawn em grupo próprio + registro. Resolve depois do evento `spawn` (o
   * binário existe e o pid é real) e do registro; rejeita com `ErroSpawn`.
   */
  async iniciar(opcoes: OpcoesProcesso): Promise<ProcessoSupervisionado> {
    if (!this.aceitando) throw new ErroSpawn('a Forja está encerrando', 'ENCERRANDO');
    const filho = spawn(opcoes.comando, [...opcoes.args], {
      cwd: opcoes.cwd,
      env: { ...opcoes.env },
      detached: true,
      stdio: [opcoes.entrada === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      const aoErro = (erro: NodeJS.ErrnoException): void => {
        filho.off('spawn', aoSpawn);
        reject(new ErroSpawn(`falha ao iniciar ${opcoes.rotulo}: ${erro.message}`, erro.code));
      };
      const aoSpawn = (): void => {
        filho.off('error', aoErro);
        resolve();
      };
      filho.once('error', aoErro);
      filho.once('spawn', aoSpawn);
    });
    // Erros posteriores (ex.: EPIPE no stdin) não podem virar exceção não tratada.
    filho.on('error', () => {});

    const pid = filho.pid!;
    const registro: ProcessoRegistrado = {
      pid,
      pgid: pid, // detached ⇒ setsid ⇒ líder do próprio grupo
      etapa_id: opcoes.etapa_id ?? null,
      inicio: this.agora().toISOString(),
      rotulo: opcoes.rotulo,
      comando: opcoes.comandoEsperado ?? opcoes.comando.split('/').pop()!,
    };
    const processo = new ProcessoSupervisionado(filho, registro, opcoes, this);
    this.ativosPorPid.set(pid, processo);

    try {
      this.registro.aoIniciar(registro);
    } catch (erro) {
      processo.marcarErroRegistro();
      void processo.encerrarPorDesligamento(ESCADA_SOBRAS);
      this.ativosPorPid.delete(pid);
      throw new ErroSpawn(
        `não foi possível registrar o pid de ${opcoes.rotulo}: ${(erro as Error).message}`,
        'REGISTRO',
      );
    }

    void processo.fim.then((fim) => {
      this.ativosPorPid.delete(pid);
      if (fim.motivo === 'erro_registro') return;
      try {
        this.registro.aoTerminar(registro, fim);
      } catch {
        // Falha de persistência no fim não pode derrubar o app; a reconciliação cobre.
      }
    });

    if (opcoes.entrada !== undefined) {
      filho.stdin!.on('error', () => {});
      filho.stdin!.end(opcoes.entrada);
    }
    return processo;
  }

  /** Escada num grupo qualquer (inclusive um órfão do boot). */
  encerrar(pgid: number, escada: EscadaSinais = ESCADA_PADRAO): Promise<ResultadoEscada> {
    const supervisionado = [...this.ativosPorPid.values()].find((p) => p.pgid === pgid);
    if (supervisionado) {
      return supervisionado
        .cancelar(escada)
        .then((fim) => fim.escada ?? { encerrado: true, sinais: [], duracao_ms: fim.duracao_ms });
    }
    return this.aplicarEscada(pgid, escada);
  }

  /**
   * Desligamento do app (01 §3.2): para de aceitar spawns e aplica a escada em
   * todos os grupos EM PARALELO (o teto é o de uma escada, não a soma).
   */
  async encerrarTodos(escada: EscadaSinais = ESCADA_PADRAO): Promise<FimProcesso[]> {
    this.aceitando = false;
    return Promise.all(
      [...this.ativosPorPid.values()].map((p) => p.encerrarPorDesligamento(escada)),
    );
  }

  /**
   * Boot: encerra os processos de uma lista registrada antes do crash (01 §6.7).
   * Só sinaliza o que a sonda reconhece como nosso (`vivo`/`grupo_orfao`).
   */
  async matarOrfaos(
    lista: readonly ProcessoRegistrado[],
    escada: EscadaSinais = ESCADA_PADRAO,
  ): Promise<ResultadoOrfao[]> {
    return Promise.all(
      lista.map(async (processo) => {
        const estado = sondarProcesso(processo, {
          leitor: this.leitor,
          grupoVivo: this.deps.escada?.grupoVivo,
        });
        const nosso = estado === 'vivo' || estado === 'grupo_orfao';
        const resultado = nosso ? await this.aplicarEscada(processo.pgid, escada) : null;
        return { processo, estado, escada: resultado };
      }),
    );
  }

  // --- internos usados por ProcessoSupervisionado ---

  /** @internal */
  sinalizar(pgid: number, sinal: NodeJS.Signals): void {
    (this.deps.escada?.sinalizarGrupo ?? sinalizarGrupoReal)(pgid, sinal);
  }

  /** @internal */
  aplicarEscada(pgid: number, escada: EscadaSinais): Promise<ResultadoEscada> {
    return encerrarGrupo(pgid, escada, this.deps.escada);
  }

  /** @internal */
  grupoTemMembros(pgid: number): boolean {
    return (this.deps.escada?.grupoVivo ?? grupoVivoReal)(pgid);
  }

  /** @internal Varredura de cwd: SIGKILL direto (já passaram pela escada do grupo). */
  async varrerSobras(raiz: string): Promise<number[]> {
    const sessoes = new Set<number>(this.deps.sessoesProtegidas?.() ?? []);
    const pids = processosNaRaiz(raiz, { leitor: this.leitor, sessoesProtegidas: sessoes });
    const mortos: number[] = [];
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        mortos.push(pid);
      } catch {
        // sumiu entre a leitura e o sinal
      }
    }
    return mortos;
  }

  /** @internal Espera os pipes fecharem; um neto segurando o stdout não prende o fim. */
  async aguardarFechamento(filho: ChildProcess, fechou: Promise<void>): Promise<void> {
    const grace = this.deps.graceFechamentoMs ?? 2_000;
    let temporizador: NodeJS.Timeout | undefined;
    const estourou = new Promise<'estourou'>((resolve) => {
      temporizador = setTimeout(() => resolve('estourou'), grace);
    });
    const resultado = await Promise.race([fechou.then(() => 'fechou' as const), estourou]);
    clearTimeout(temporizador);
    if (resultado === 'estourou') {
      for (const s of [filho.stdout, filho.stderr]) s?.destroy();
    }
  }
}
