import { spawn as spawnNode } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NomeContrato } from '../../comum/contratos';
import { validarContrato } from '../../comum/contratos';
import type { ClassificacaoProcesso } from '../../comum/estados';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import { REDATOR_GENERICO, type Redator } from '../eventos/normalizador';
import { VERSAO_CLI_FIXADA } from './compat';
import { LockSessoes } from './lock-sessoes';
import type { ComandoClaude } from './perfis';
import { PAPEL_PRINCIPAL_DO_PERFIL, TURNO_DO_PERFIL } from './perfis';
import { analisarLinha, DivisorLinhas, NormalizadorStream, type SinalStream } from './stream';
import {
  extrairResultadoFinal,
  modelosInesperados,
  resetsAtRejeitado,
  snapshotUso,
  type ResultadoFinal,
  type SnapshotUso,
} from './telemetria';
import { validarInit, type ResultadoValidacaoInit } from './validacao-init';

/**
 * Runner da CLI do Claude (specs/forja/01 §6; §3.2 para o supervisor).
 *
 * `Runner` é a ÚNICA porta do orquestrador para agentes: `iniciar(comando,
 * entrada)` devolve uma `ExecucaoProcesso` com `eventos` (assíncrono),
 * `pausar()` (SIGINT), `cancelar()` (escada) e `resultado` (promessa com UMA
 * classificação de 01 §6.6). Um backend SDK só entraria pela mesma interface.
 *
 * Regras do spawn que vivem aqui (o resto — flags e env — é de `perfis.ts`):
 * - `detached: true`: o filho lidera o próprio grupo e todo sinal vai para
 *   `-pgid`. [V S4] isso NÃO alcança os comandos do Bash do agente: cada um
 *   roda em sessão própria (`setsid`), fora do grupo. Só o SIGTERM na CLI
 *   (que mata a árvore do Bash) ou a varredura do cwd de cada `/proc/<pid>` na worktree
 *   (01 §3.2) os encerram — a varredura é obrigatória: o orquestrador varre
 *   na pausa/cancelamento e o próprio runner (`varrerCwd`) no timeout, no
 *   perfil divergente e quando o consumidor abandona o stream;
 * - stdin = pipe: o prompt inteiro é escrito e o pipe FECHADO (evita o aviso de
 *   3 s da CLI e o limite de argv; o pipe aceita até 10 MB);
 * - stdout lido continuamente, linha a linha, sem nunca esperar por quem
 *   consome os eventos (a CLI espera até 30 s para drenar ao sair, e um cliente
 *   SSE lento não pode travar o agente): os eventos vão para uma fila em memória;
 * - escada SIGINT → 10 s → SIGTERM → 10 s → SIGKILL no grupo (pausa,
 *   cancelamento, timeout); o aborto por perfil divergente começa no SIGTERM;
 * - sem evento no stream por 15 min: AVISO, nunca kill (um build longo é mudo);
 * - lock por `session_id` durante toda a vida do processo;
 * - todo `system/init` é validado contra o perfil (01 §6.4) e todo
 *   `structured_output` é revalidado pelo zod do contrato do turno.
 *
 * `spawn` e o envio de sinais são injetáveis: os testes rodam com um processo
 * falso, e nenhum teste chama o `claude` real.
 */

// ---------------------------------------------------------------------------
// Processo filho (porta injetável)
// ---------------------------------------------------------------------------

interface Emissor {
  on(evento: string, ouvinte: (...args: unknown[]) => void): unknown;
}

export interface EntradaPadraoFilho {
  write(dado: string): boolean;
  end(): void;
  on(evento: 'error', ouvinte: (erro: Error) => void): unknown;
}

/** O mínimo de `ChildProcess` que o runner usa. */
export interface ProcessoFilho extends Emissor {
  readonly pid?: number;
  readonly stdin: EntradaPadraoFilho | null;
  readonly stdout: Emissor | null;
  readonly stderr: Emissor | null;
}

export interface OpcoesSpawn {
  cwd: string;
  env: Record<string, string>;
  detached: true;
  stdio: ['pipe', 'pipe', 'pipe'];
}

export type FuncaoSpawn = (
  executavel: string,
  args: string[],
  opcoes: OpcoesSpawn,
) => ProcessoFilho;

/** Envia um sinal ao GRUPO do processo (`-pgid`). */
export type FuncaoSinal = (pgid: number, sinal: NodeJS.Signals) => void;

export const spawnPadrao: FuncaoSpawn = (executavel, args, opcoes) =>
  spawnNode(executavel, args, opcoes) as unknown as ProcessoFilho;

export const sinalizarGrupoPadrao: FuncaoSinal = (pgid, sinal) => {
  try {
    process.kill(-pgid, sinal);
  } catch (e) {
    // ESRCH: o grupo já acabou. Qualquer outro erro sobe.
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
};

// ---------------------------------------------------------------------------
// Persistência do bruto (02 §7: `etapas/<n>/eventos.jsonl` e `stderr.log`)
// ---------------------------------------------------------------------------

export interface PersistenciaBruta {
  linhaStdout(linha: string): void;
  stderr(trecho: string): void;
  fechar(): Promise<void>;
}

/**
 * Grava o stream bruto linha a linha em `<dirEtapa>/eventos.jsonl` e o stderr
 * em `stderr.log` (0600), REDIGIDOS antes de tocar o disco (05 §8.2: um `cat
 * .env` do agente não pode ficar em claro por 90 dias). Sem `redator`, valem
 * os padrões genéricos; quem conhece os valores sensíveis (token, `.env`
 * copiados) passa um `Redator` com eles. Os padrões não atravessam `"`: a
 * linha continua JSON válido.
 */
export function persistenciaEmArquivos(
  dirEtapa: string,
  redator: Redator = REDATOR_GENERICO,
): PersistenciaBruta {
  mkdirSync(dirEtapa, { recursive: true, mode: 0o700 });
  const eventos = createWriteStream(join(dirEtapa, 'eventos.jsonl'), { flags: 'a', mode: 0o600 });
  const stderr = createWriteStream(join(dirEtapa, 'stderr.log'), { flags: 'a', mode: 0o600 });
  const fecharUm = (s: NodeJS.WritableStream) => new Promise<void>((ok) => s.end(ok));
  return {
    linhaStdout: (linha) => void eventos.write(`${redator.redigir(linha)}\n`),
    stderr: (trecho) => void stderr.write(redator.redigir(trecho)),
    fechar: async () => {
      await Promise.all([fecharUm(eventos), fecharUm(stderr)]);
    },
  };
}

// ---------------------------------------------------------------------------
// Interface Runner
// ---------------------------------------------------------------------------

export interface EntradaProcesso {
  /** Prompt inteiro (B4/B5 ou mensagem/retomada/correção), escrito no stdin e fechado. */
  prompt: string;
  execucaoId: string | null;
  etapaId: string | null;
  /** Timeout da etapa (01 §3.2): dispara a escada e classifica `timeout`. */
  timeoutMs: number;
  /** Sem evento por este tempo: aviso `possivelmente_travado` (padrão 15 min). */
  avisoInatividadeMs?: number;
  persistencia?: PersistenciaBruta | null;
  /**
   * Pós-mortem de autenticação (01 §6.6): chamado quando o fim seria
   * `interrompido`/`erro_execucao`; `false` = `claude auth status` falhou.
   */
  verificarAuth?: (() => Promise<boolean>) | null;
}

export type EventoRunner =
  | { tipo: 'evento'; evento: NovoEventoForja }
  /** Snapshot para `uso_assinatura` + `uso.atualizado` (o freio é do domínio, 03 §7.6). */
  | { tipo: 'uso'; snapshot: SnapshotUso }
  /** Um `implementador` retornou: commit de checkpoint do app se `emVoo = 0` (03 §3.3). */
  | { tipo: 'checkpoint'; toolUseId: string; emVoo: number }
  /** Resultado da validação de um `init` (recorte para `etapa.init`). */
  | { tipo: 'init'; validacao: ResultadoValidacaoInit };

export type MotivoParada = 'pausa' | 'cancelamento' | 'timeout' | 'perfil';

export interface ResultadoProcesso {
  classificacao: ClassificacaoProcesso;
  sessionId: string;
  contrato: NomeContrato | null;
  /** `structured_output` aprovado pelo zod do contrato (null se não houve ou não passou). */
  saida: unknown;
  /** Erros do zod quando o contrato não passou (alimentam a recusa com instrução, 04 §6). */
  errosContrato: string[];
  /** Último `result` (maior `result_index`). */
  final: ResultadoFinal | null;
  totalResults: number;
  /** `cota`: quando a janela reabre (ISO), se a CLI disse. */
  resetsAt: string | null;
  /** Último `init` validado (null = processo morreu antes do init). */
  init: ResultadoValidacaoInit | null;
  /** T1: agentes do `init` fora do papel — atualizar o cache e reiniciar 1× (01 §6.2). */
  agentesForaDoPapel: string[];
  modelosInesperados: string[];
  exitCode: number | null;
  sinal: string | null;
  duracaoMs: number;
  /** Fim do stderr (até 4 KB), para diagnóstico e para a retomada (01 §6.7 passo 3). */
  stderrFinal: string;
}

export interface ExecucaoProcesso {
  readonly sessionId: string;
  /** Gravar em `etapa.pid`/`pgid` logo após o spawn (01 §3.2). */
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly eventos: AsyncIterable<EventoRunner>;
  /** SIGINT (encerra o turno com registro) e escada se não sair. Classificação `pausado`. */
  pausar(): Promise<ResultadoProcesso>;
  /** Escada completa. Classificação `cancelado`. */
  cancelar(): Promise<ResultadoProcesso>;
  readonly resultado: Promise<ResultadoProcesso>;
}

export interface Runner {
  iniciar(comando: ComandoClaude, entrada: EntradaProcesso): ExecucaoProcesso;
}

// ---------------------------------------------------------------------------
// Classificação (01 §6.6)
// ---------------------------------------------------------------------------

export interface InsumosClassificacao {
  parada: MotivoParada | null;
  final: ResultadoFinal | null;
  contratoExigido: boolean;
  contratoValido: boolean;
  autenticacaoFalhou: boolean;
  cota: { textoLimite: boolean; rateLimitRejeitado: boolean; retryRateLimitEsgotado: boolean };
}

/**
 * Uma única classificação por processo. O mapeamento para estados de execução é de 03.
 *
 * Precedência:
 * 1. parada pedida pelo app que o orquestrador JÁ aplicou ao estado da
 *    execução (perfil, cancelamento, pausa): a classificação a acompanha — o
 *    `saida` validado continua no resultado para quem quiser reaproveitá-lo;
 * 2. `result` de sucesso com contrato válido = `concluido`, mesmo com timeout
 *    disparado depois dele (o turno acabou; só a saída do processo atrasou) ou
 *    com um `api_retry authentication_failed` passageiro no meio do turno;
 * 3. timeout; sucesso com contrato inválido; autenticação;
 * 4. limites declarados pela própria CLI no `result` (orçamento, turnos,
 *    retries de schema) ANTES dos sinais de cota — um texto que case "hit
 *    your … limit" não troca um `error_max_budget_usd` por `cota`;
 * 5. cota; o resto é `interrompido`/`erro_execucao`.
 */
export function classificarFim(i: InsumosClassificacao): ClassificacaoProcesso {
  if (i.parada === 'perfil') return 'perfil_divergente';
  if (i.parada === 'cancelamento') return 'cancelado';
  if (i.parada === 'pausa') return 'pausado';
  const final = i.final;
  const sucesso = final !== null && final.subtype === 'success' && !final.is_error;
  if (sucesso && (!i.contratoExigido || i.contratoValido)) return 'concluido';
  if (i.parada === 'timeout') return 'timeout';
  if (sucesso) return 'saida_invalida';
  if (i.autenticacaoFalhou) return 'autenticacao';
  const cota = i.cota.textoLimite || i.cota.rateLimitRejeitado || i.cota.retryRateLimitEsgotado;
  if (!final) return cota ? 'cota' : 'interrompido';
  switch (final.subtype) {
    case 'error_max_structured_output_retries':
      return 'saida_invalida';
    case 'error_max_budget_usd':
      return 'limite_orcamento';
    case 'error_max_turns':
      return 'limite_turnos';
    default:
      // `is_error` com subtype success (ou erro durante a execução): cota se houve sinal dela.
      return cota ? 'cota' : 'erro_execucao';
  }
}

// ---------------------------------------------------------------------------
// Fila assíncrona (o leitor do stdout nunca espera o consumidor)
// ---------------------------------------------------------------------------

class FilaAssincrona<T> implements AsyncIterable<T> {
  private readonly itens: T[] = [];
  private esperando: ((r: IteratorResult<T>) => void)[] = [];
  private fim = false;

  /** Chamado uma vez se o consumidor abandona o `for await` antes do fim (exceção ou `break`). */
  constructor(private readonly aoAbandonar: () => void = () => {}) {}

  empurrar(item: T): void {
    if (this.fim) return;
    const espera = this.esperando.shift();
    if (espera) espera({ value: item, done: false });
    else this.itens.push(item);
  }

  encerrar(): void {
    this.fim = true;
    for (const espera of this.esperando) espera({ value: undefined, done: true });
    this.esperando = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.itens.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.fim) return Promise.resolve({ value: undefined, done: true });
        return new Promise((ok) => this.esperando.push(ok));
      },
      return: () => {
        if (!this.fim) this.aoAbandonar();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Implementação CLI
// ---------------------------------------------------------------------------

export const ESPERA_ESCADA_MS = 10_000;
export const AVISO_INATIVIDADE_MS = 15 * 60_000;
/** Teto do pipe de stdin da CLI (01 §6.1 [V]). */
export const LIMITE_PROMPT_BYTES = 10 * 1024 * 1024;
const LIMITE_STDERR_FINAL = 4096;

export interface OpcoesRunnerCli {
  spawn?: FuncaoSpawn;
  sinalizar?: FuncaoSinal;
  locks?: LockSessoes;
  /**
   * Versão da CLI que o `init` precisa trazer. Função = lida A CADA init (o
   * "Aceitar versão X" em runtime passa a valer sem reiniciar o app); string =
   * fixa (testes, smoke).
   */
  versaoFixada?: string | (() => string);
  /**
   * `init` com versão divergente da liberada (01 §6.4): quem liga avisa o
   * compat para BLOQUEAR o pipeline (o orquestrador para de iniciar etapas que
   * morreriam uma a uma). A etapa em curso já é abortada como `perfil_divergente`.
   */
  aoVersaoDivergente?: (info: { encontrada: string | null; esperada: string }) => void;
  /**
   * Pós-mortem de autenticação padrão (01 §6.6) quando a `EntradaProcesso` não
   * traz o seu: `false` = `claude auth status` falhou.
   */
  verificarAuth?: (() => Promise<boolean>) | null;
  /**
   * Varredura do cwd (01 §3.2, [V S4]): os comandos do Bash do agente rodam em
   * `setsid`, fora do grupo — a escada no `-pgid` não os alcança. Chamada ao
   * fim de todo processo que o RUNNER parou (timeout, perfil divergente,
   * consumidor que abandonou o stream), antes de resolver o resultado.
   * Pausa/cancelamento pedidos pelo orquestrador já varrem lá.
   */
  varrerCwd?: ((cwd: string) => Promise<number>) | null;
  esperaEscadaMs?: number;
  agora?: () => number;
}

export class ErroRunner extends Error {}

export class RunnerCli implements Runner {
  private readonly spawn: FuncaoSpawn;
  private readonly sinalizar: FuncaoSinal;
  readonly locks: LockSessoes;
  private readonly versaoFixada: () => string;
  private readonly opcoes: OpcoesRunnerCli;
  private readonly esperaEscadaMs: number;
  private readonly agora: () => number;
  private contador = 0;

  constructor(opcoes: OpcoesRunnerCli = {}) {
    this.spawn = opcoes.spawn ?? spawnPadrao;
    this.sinalizar = opcoes.sinalizar ?? sinalizarGrupoPadrao;
    this.locks = opcoes.locks ?? new LockSessoes();
    const versao = opcoes.versaoFixada ?? VERSAO_CLI_FIXADA;
    this.versaoFixada = typeof versao === 'function' ? versao : () => versao;
    this.opcoes = opcoes;
    this.esperaEscadaMs = opcoes.esperaEscadaMs ?? ESPERA_ESCADA_MS;
    this.agora = opcoes.agora ?? Date.now;
  }

  iniciar(comando: ComandoClaude, entrada: EntradaProcesso): ExecucaoProcesso {
    if (Buffer.byteLength(entrada.prompt, 'utf8') > LIMITE_PROMPT_BYTES) {
      throw new ErroRunner('prompt acima de 10 MB (limite do stdin da CLI)');
    }
    this.contador += 1;
    const dono = `runner:${entrada.etapaId ?? 'sem-etapa'}:${this.contador}`;
    this.locks.adquirir(comando.sessionId, dono);
    try {
      return new ProcessoCli(this, comando, entrada, dono);
    } catch (e) {
      this.locks.liberar(comando.sessionId, dono);
      throw e;
    }
  }

  /** @internal */
  get dependencias() {
    return {
      spawn: this.spawn,
      sinalizar: this.sinalizar,
      versaoFixada: this.versaoFixada,
      aoVersaoDivergente: this.opcoes.aoVersaoDivergente,
      verificarAuth: this.opcoes.verificarAuth ?? null,
      varrerCwd: this.opcoes.varrerCwd ?? null,
      esperaEscadaMs: this.esperaEscadaMs,
      agora: this.agora,
    };
  }
}

class ProcessoCli implements ExecucaoProcesso {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly resultado: Promise<ResultadoProcesso>;
  private readonly fila = new FilaAssincrona<EventoRunner>(() => this.abandonado());
  private readonly normalizador: NormalizadorStream;
  private readonly divisor = new DivisorLinhas();
  private readonly inicio: number;
  private parada: MotivoParada | null = null;
  private finalizado = false;
  private resolver!: (r: ResultadoProcesso) => void;
  private ultimaValidacao: ResultadoValidacaoInit | null = null;
  private agentesForaDoPapel: string[] = [];
  private autenticacaoFalhou = false;
  private retryRateLimitEsgotado = false;
  private rateLimitRejeitado = false;
  private resetsAt: string | null = null;
  private stderrFinal = '';
  private timers: ReturnType<typeof setTimeout>[] = [];
  private timerInatividade: ReturnType<typeof setTimeout> | null = null;
  private avisouInatividade = false;
  private abandonou = false;

  constructor(
    private readonly runner: RunnerCli,
    private readonly comando: ComandoClaude,
    private readonly entrada: EntradaProcesso,
    private readonly dono: string,
  ) {
    const deps = runner.dependencias;
    this.sessionId = comando.sessionId;
    this.inicio = deps.agora();
    this.resultado = new Promise((ok) => (this.resolver = ok));
    const perfil = comando.esperado.perfil;
    this.normalizador = new NormalizadorStream({
      execucaoId: entrada.execucaoId,
      etapaId: entrada.etapaId,
      papelPrincipal: PAPEL_PRINCIPAL_DO_PERFIL[perfil],
      turno: TURNO_DO_PERFIL[perfil],
    });

    const filho = deps.spawn(comando.executavel, comando.args, {
      cwd: comando.cwd,
      env: comando.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = typeof filho.pid === 'number' ? filho.pid : null;
    // `detached: true` ⇒ o filho é líder do próprio grupo: pgid = pid.
    this.pgid = this.pid;

    filho.on('error', (erro) => {
      this.alerta('spawn_falhou', `Falha ao iniciar a CLI: ${(erro as Error).message}`, true);
      if (this.pid === null) this.finalizar(null, null);
    });
    filho.on('close', (codigo, sinal) => {
      this.finalizar(
        typeof codigo === 'number' ? codigo : null,
        typeof sinal === 'string' ? sinal : null,
      );
    });
    filho.stdout?.on('data', (chunk) => this.dados(chunk as Buffer | string));
    filho.stderr?.on('data', (chunk) => {
      const trecho = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      this.entrada.persistencia?.stderr(trecho);
      this.stderrFinal = (this.stderrFinal + trecho).slice(-LIMITE_STDERR_FINAL);
    });

    if (filho.stdin) {
      filho.stdin.on('error', () => {
        // EPIPE: o processo saiu antes de ler o prompt; o fim será classificado pelo `close`.
      });
      filho.stdin.write(entrada.prompt);
      filho.stdin.end();
    }

    this.timers.push(setTimeout(() => void this.parar('timeout', 'SIGINT'), entrada.timeoutMs));
    this.rearmarInatividade();
  }

  get eventos(): AsyncIterable<EventoRunner> {
    return this.fila;
  }

  pausar(): Promise<ResultadoProcesso> {
    return this.parar('pausa', 'SIGINT');
  }

  cancelar(): Promise<ResultadoProcesso> {
    return this.parar('cancelamento', 'SIGINT');
  }

  /**
   * O consumidor saiu do `for await` antes do fim (exceção no laço do
   * orquestrador: git, SQLite, publicar). Ninguém mais acompanha este agente
   * em bypass: escada completa, como num cancelamento (o lock é solto no fim).
   */
  private abandonado(): void {
    if (this.finalizado) return;
    this.abandonou = true;
    void this.parar('cancelamento', 'SIGINT');
  }

  private parar(motivo: MotivoParada, primeiro: 'SIGINT' | 'SIGTERM'): Promise<ResultadoProcesso> {
    if (this.finalizado) return this.resultado;
    if (this.parada) {
      // Já parando: um cancelamento explícito prevalece sobre a pausa, a escada segue a mesma.
      if (motivo === 'cancelamento' && this.parada === 'pausa') this.parada = motivo;
      return this.resultado;
    }
    this.parada = motivo;
    const deps = this.runner.dependencias;
    const escada: NodeJS.Signals[] =
      primeiro === 'SIGINT' ? ['SIGINT', 'SIGTERM', 'SIGKILL'] : ['SIGTERM', 'SIGKILL'];
    const enviar = (i: number) => {
      if (this.finalizado || this.pgid === null) return;
      const sinal = escada[i];
      if (!sinal) return;
      deps.sinalizar(this.pgid, sinal);
      if (i + 1 < escada.length)
        this.timers.push(setTimeout(() => enviar(i + 1), deps.esperaEscadaMs));
    };
    enviar(0);
    return this.resultado;
  }

  private rearmarInatividade(): void {
    if (this.timerInatividade) clearTimeout(this.timerInatividade);
    if (this.finalizado) return;
    const ms = this.entrada.avisoInatividadeMs ?? AVISO_INATIVIDADE_MS;
    this.timerInatividade = setTimeout(() => {
      if (this.finalizado || this.avisouInatividade) return;
      this.avisouInatividade = true;
      this.alerta(
        'possivelmente_travado',
        `Sem evento da CLI há ${Math.round(ms / 60_000)} min (aviso; o processo não é encerrado)`,
        false,
      );
    }, ms);
  }

  private alerta(
    codigo: string,
    resumo: string,
    bloqueante: boolean,
    nivel: 'aviso' | 'erro' = 'aviso',
  ) {
    this.fila.empurrar({
      tipo: 'evento',
      evento: {
        execucao_id: this.entrada.execucaoId,
        etapa_id: this.entrada.etapaId,
        tipo: 'cli.alerta',
        nivel: bloqueante ? 'erro' : nivel,
        resumo,
        dados: { codigo, bloqueante },
      },
    });
  }

  private dados(chunk: Buffer | string): void {
    for (const linha of this.divisor.empurrar(chunk)) this.linha(linha);
  }

  private linha(linha: string): void {
    this.entrada.persistencia?.linhaStdout(linha);
    this.avisouInatividade = false;
    this.rearmarInatividade();
    const analisada = analisarLinha(linha);
    const saida =
      analisada.tipo === 'mensagem'
        ? this.normalizador.processar(analisada.mensagem)
        : this.normalizador.linhaInvalida(analisada.erro);
    for (const evento of saida.eventos) this.fila.empurrar({ tipo: 'evento', evento });
    for (const sinal of saida.sinais) this.sinal(sinal);
  }

  private sinal(sinal: SinalStream): void {
    switch (sinal.tipo) {
      case 'init': {
        const deps = this.runner.dependencias;
        const esperada = deps.versaoFixada();
        const validacao = validarInit(sinal.init, this.comando.esperado, esperada);
        this.ultimaValidacao = validacao;
        this.fila.empurrar({ tipo: 'init', validacao });
        for (const a of validacao.alertas) {
          this.alerta(
            a.startsWith('MCP do Chamados') ? 'mcp_chamados' : 'plugins_carregados',
            a,
            false,
          );
        }
        if (validacao.versaoDivergente) {
          this.alerta(
            'versao_cli_divergente',
            validacao.divergencias[0] ?? 'versão da CLI divergente',
            true,
          );
          try {
            deps.aoVersaoDivergente?.({
              encontrada:
                typeof sinal.init.claude_code_version === 'string'
                  ? sinal.init.claude_code_version
                  : null,
              esperada,
            });
          } catch {
            // Ouvinte com defeito não impede o aborto da etapa.
          }
        }
        if (validacao.agentesForaDoPapel.length) {
          this.agentesForaDoPapel = validacao.agentesForaDoPapel;
          this.alerta(
            'agentes_fora_do_papel',
            `Agentes fora do papel no init: ${validacao.agentesForaDoPapel.join(', ')}`,
            false,
            'erro',
          );
        }
        if (!validacao.ok) {
          for (const d of validacao.divergencias)
            this.alerta('perfil_divergente', d, false, 'erro');
          void this.parar('perfil', 'SIGTERM');
        }
        break;
      }
      case 'rate_limit': {
        this.fila.empurrar({ tipo: 'uso', snapshot: snapshotUso(sinal.info) });
        const resets = resetsAtRejeitado(sinal.info);
        if (sinal.info.status === 'rejected') {
          this.rateLimitRejeitado = true;
          this.resetsAt = resets ?? this.resetsAt;
        }
        break;
      }
      case 'api_retry':
        if (sinal.erro === 'authentication_failed') this.autenticacaoFalhou = true;
        if (
          sinal.erro === 'rate_limit' &&
          sinal.tentativa !== null &&
          sinal.maxTentativas !== null &&
          sinal.tentativa >= sinal.maxTentativas
        ) {
          this.retryRateLimitEsgotado = true;
        }
        break;
      case 'implementador_retornou':
        this.fila.empurrar({ tipo: 'checkpoint', toolUseId: sinal.toolUseId, emVoo: sinal.emVoo });
        break;
      case 'result':
        break;
    }
  }

  private finalizar(codigo: number | null, sinal: string | null): void {
    if (this.finalizado) return;
    this.finalizado = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.timerInatividade) clearTimeout(this.timerInatividade);
    for (const linha of this.divisor.finalizar()) this.linha(linha);
    void this.concluir(codigo, sinal);
  }

  private async concluir(codigo: number | null, sinal: string | null): Promise<void> {
    const ultimo = this.normalizador.ultimoResult;
    const final = ultimo ? extrairResultadoFinal(ultimo) : null;
    const contrato = this.comando.contrato;
    let saida: unknown = null;
    let errosContrato: string[] = [];
    if (contrato && final && final.subtype === 'success') {
      if (final.structured_output === undefined || final.structured_output === null) {
        errosContrato = ['o result de sucesso veio sem structured_output'];
      } else {
        const r = validarContrato(contrato, final.structured_output);
        if (r.success) saida = r.data;
        else
          errosContrato = r.error.issues.map(
            (i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`,
          );
      }
    }
    let classificacao = classificarFim({
      parada: this.parada,
      final,
      contratoExigido: contrato !== null,
      contratoValido: saida !== null,
      autenticacaoFalhou: this.autenticacaoFalhou,
      cota: {
        textoLimite: this.normalizador.textoLimiteCota,
        rateLimitRejeitado: this.rateLimitRejeitado,
        retryRateLimitEsgotado: this.retryRateLimitEsgotado,
      },
    });
    const deps = this.runner.dependencias;
    const verificarAuth = this.entrada.verificarAuth ?? deps.verificarAuth;
    if ((classificacao === 'interrompido' || classificacao === 'erro_execucao') && verificarAuth) {
      try {
        if (!(await verificarAuth())) classificacao = 'autenticacao';
      } catch {
        // O pós-mortem é melhor esforço: sem resposta, fica a classificação original.
      }
    }
    if (classificacao === 'autenticacao') {
      this.alerta('login', 'A CLI está sem login: refaça o login no Terminal', true);
    }
    const inesperados = final
      ? modelosInesperados(final.modelUsage, this.comando.esperado.modelosPermitidos)
      : [];
    if (inesperados.length) {
      this.alerta(
        'modelo_inesperado',
        `Modelos fora do perfil no result: ${inesperados.join(', ')}`,
        false,
        'erro',
      );
    }
    if (errosContrato.length) {
      this.alerta(
        'saida_invalida',
        `Contrato ${contrato} recusado: ${errosContrato.slice(0, 3).join('; ')}`,
        false,
      );
    }
    const paradaPeloRunner =
      this.parada === 'timeout' || this.parada === 'perfil' || this.abandonou;
    if (paradaPeloRunner && deps.varrerCwd) {
      try {
        await deps.varrerCwd(this.comando.cwd);
      } catch {
        // Melhor esforço: a reconciliação do boot varre de novo.
      }
    }
    try {
      await this.entrada.persistencia?.fechar();
    } catch {
      // Falha ao fechar o log bruto não muda a classificação; o SQLite já tem os eventos.
    }
    this.runner.locks.liberar(this.sessionId, this.dono);
    this.fila.encerrar();
    this.resolver({
      classificacao,
      sessionId: this.sessionId,
      contrato,
      saida,
      errosContrato,
      final,
      totalResults: this.normalizador.totalResults,
      resetsAt: this.resetsAt,
      init: this.ultimaValidacao,
      agentesForaDoPapel: this.agentesForaDoPapel,
      modelosInesperados: inesperados,
      exitCode: codigo,
      sinal,
      duracaoMs: deps.agora() - this.inicio,
      stderrFinal: this.stderrFinal,
    });
  }
}
