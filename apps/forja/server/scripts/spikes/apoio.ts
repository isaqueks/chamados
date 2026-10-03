import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { montarEnvBase } from '../../claude/perfis';
import { analisarLinha, DivisorLinhas, type MensagemCli } from '../../claude/stream';
import { git } from '../../git/git';

/**
 * Apoio comum dos spikes S1–S10 (specs/forja/08 §2).
 *
 * POR QUE um módulo à parte: todo spike precisa das mesmas quatro coisas — um
 * relatório de critérios com veredito PASSOU/FALHOU/PENDENTE, um spawn CRU da
 * CLI que guarda cada linha do stream com o instante de chegada (o S3 mede
 * paralelismo e o S4 reage no meio do turno, o que o `RunnerCli` não expõe),
 * um clone descartável do Chamados (nunca o repositório de trabalho) e o
 * ambiente allowlist da Forja (`montarEnvBase`, 01 §6.1), que já tira
 * `CLAUDECODE`/`CLAUDE_CODE_*` herdados de uma sessão do Claude Code — sem isso
 * a CLI aninhada se comporta como sessão filha.
 *
 * Os spikes chamam a CLI REAL com a assinatura do usuário; por isso não há
 * teste unitário deles, só das funções puras daqui (`apoio.test.ts`).
 */

export type Veredito = 'PASSOU' | 'FALHOU' | 'PENDENTE';

export interface Criterio {
  id: string;
  descricao: string;
  veredito: Veredito;
  detalhe: string;
}

/** Diretório dos artefatos brutos. `FORJA_SPIKES_SAIDA` sobrepõe (08 §2: `apps/forja/spikes/`). */
export function dirSaida(): string {
  return process.env.FORJA_SPIKES_SAIDA ?? join(tmpdir(), 'forja-spikes');
}

/** `true` → PASSOU, `false` → FALHOU, `null` → PENDENTE. */
export function vereditoDe(cond: boolean | null): Veredito {
  if (cond === null) return 'PENDENTE';
  return cond ? 'PASSOU' : 'FALHOU';
}

/** Veredito do spike inteiro: qualquer FALHOU reprova; só PENDENTE (sem PASSOU) é PENDENTE. */
export function vereditoGeral(criterios: readonly Criterio[]): Veredito {
  if (criterios.some((c) => c.veredito === 'FALHOU')) return 'FALHOU';
  if (criterios.length === 0 || criterios.every((c) => c.veredito === 'PENDENTE'))
    return 'PENDENTE';
  return 'PASSOU';
}

export class RelatorioSpike {
  readonly criterios: Criterio[] = [];
  readonly dados: Record<string, unknown> = {};
  readonly inicio = new Date().toISOString();

  constructor(readonly spike: string) {}

  criterio(id: string, descricao: string, veredito: Veredito, detalhe: string): void {
    this.criterios.push({ id, descricao, veredito, detalhe });
    console.log(`  [${veredito.padEnd(8)}] ${id} — ${descricao}: ${detalhe}`);
  }

  anexar(chave: string, valor: unknown): void {
    this.dados[chave] = valor;
  }

  /** Grava `<saída>/<spike>.json` (critérios + dados) e devolve o caminho. */
  async gravar(): Promise<string> {
    const dir = dirSaida();
    await mkdir(dir, { recursive: true });
    const arquivo = join(dir, `${this.spike}.json`);
    const corpo = {
      spike: this.spike,
      inicio: this.inicio,
      fim: new Date().toISOString(),
      veredito: vereditoGeral(this.criterios),
      criterios: this.criterios,
      dados: this.dados,
    };
    await writeFile(arquivo, `${JSON.stringify(corpo, null, 2)}\n`);
    return arquivo;
  }

  imprimirResumo(): void {
    const geral = vereditoGeral(this.criterios);
    const conta = (v: Veredito) => this.criterios.filter((c) => c.veredito === v).length;
    console.log(
      `\n[${this.spike}] ${geral} — ${conta('PASSOU')} passou, ${conta('FALHOU')} falhou, ${conta('PENDENTE')} pendente`,
    );
  }
}

/** Roda o spike com cabeçalho, gravação e código de saída (1 se algum critério FALHOU). */
export async function executarSpike(
  spike: string,
  titulo: string,
  corpo: (r: RelatorioSpike) => Promise<void>,
): Promise<number> {
  const r = new RelatorioSpike(spike);
  console.log(`[${spike}] ${titulo}`);
  try {
    await corpo(r);
  } catch (e) {
    r.criterio(
      'execucao',
      'o spike rodou até o fim',
      'FALHOU',
      e instanceof Error ? (e.stack ?? e.message) : String(e),
    );
  }
  const arquivo = await r.gravar();
  r.imprimirResumo();
  console.log(`[${spike}] artefato: ${arquivo}`);
  return vereditoGeral(r.criterios) === 'FALHOU' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Ambiente e caminhos
// ---------------------------------------------------------------------------

/** Raiz do monorepo (este arquivo está em `apps/forja/server/scripts/spikes`). */
export const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Allowlist da Forja (01 §6.1) + extras. Nunca herda `CLAUDECODE`/`CLAUDE_CODE_*`. */
export function envClaude(extras: Record<string, string> = {}): Record<string, string> {
  return { ...montarEnvBase({ envOrigem: process.env }), ...extras };
}

/** Modelo barato para a MECÂNICA (deny, agentes, resume, sinais, PTY). */
export const MODELO_MECANICA = 'haiku';
/** ID completo do haiku (o `agentes.json` exige ID completo, `settings-gerados.ts`). */
export const MODELO_MECANICA_ID = 'claude-haiku-4-5-20251001';

/** Lê um `.env` simples (`CHAVE=valor`), sem sobrescrever o que já está no ambiente. */
export function carregarEnvArquivo(caminho: string): string[] {
  if (!existsSync(caminho)) return [];
  const carregadas: string[] = [];
  for (const bruta of readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const i = linha.indexOf('=');
    if (i <= 0) continue;
    const chave = linha.slice(0, i).trim();
    let valor = linha.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(valor)) valor = valor.slice(1, -1);
    if (process.env[chave] === undefined) {
      process.env[chave] = valor;
      carregadas.push(chave);
    }
  }
  return carregadas;
}

export interface AreaTemporaria {
  raiz: string;
  limpar(): Promise<void>;
}

export async function criarAreaTemporaria(prefixo: string): Promise<AreaTemporaria> {
  const raiz = await mkdtemp(join(tmpdir(), `forja-${prefixo}-`));
  return { raiz, limpar: () => rm(raiz, { recursive: true, force: true }) };
}

export interface CloneDescartavel {
  /** Remoto bare descartável (o `origin` do clone): um push nunca alcança o repo real. */
  remoto: string;
  /** Clone de trabalho (cwd dos agentes). */
  dir: string;
}

/**
 * Clone raso do último commit do Chamados num diretório temporário, com o
 * `origin` apontando para um bare TAMBÉM temporário (08 §2: nunca no repo de
 * trabalho; um `git push` do agente que escape do deny cai no bare).
 */
export async function clonarDescartavel(
  area: AreaTemporaria,
  nome = 'repo',
): Promise<CloneDescartavel> {
  const remoto = join(area.raiz, `${nome}-remoto.git`);
  const dir = join(area.raiz, nome);
  await git(['clone', '--quiet', '--bare', '--depth', '1', `file://${RAIZ_REPO}`, remoto], {
    cwd: area.raiz,
    timeoutMs: 300_000,
  });
  await git(['clone', '--quiet', remoto, dir], { cwd: area.raiz, timeoutMs: 300_000 });
  await git(['config', 'user.email', 'spike@forja.local'], { cwd: dir });
  await git(['config', 'user.name', 'Spike Forja'], { cwd: dir });
  return { remoto, dir };
}

// ---------------------------------------------------------------------------
// Spawn cru da CLI
// ---------------------------------------------------------------------------

export interface LinhaCrua {
  /** ms desde o spawn. */
  t: number;
  linha: string;
}

export interface MensagemDatada {
  t: number;
  m: MensagemCli;
}

export interface Rodada {
  rotulo: string;
  args: string[];
  pid: number | null;
  linhas: LinhaCrua[];
  mensagens: MensagemDatada[];
  stderr: string;
  exitCode: number | null;
  sinal: string | null;
  duracaoMs: number;
}

export interface EntradaRodada {
  rotulo: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  /** Teto de segurança: SIGKILL no grupo (o spike nunca fica pendurado). */
  timeoutMs?: number;
  /** Reage a cada mensagem (S4: SIGINT no meio; init-only: mata após o `init`). */
  aoMensagem?: (m: MensagemCli, controle: ControleRodada) => void;
}

export interface ControleRodada {
  readonly pid: number | null;
  readonly t: () => number;
  /** Sinal no GRUPO (o spawn é `detached`, como o runner). */
  sinalizar(sinal: NodeJS.Signals): void;
}

export interface RodadaEmCurso {
  controle: ControleRodada;
  processo: ChildProcess;
  fim: Promise<Rodada>;
}

export function sinalizarGrupo(pgid: number | null, sinal: NodeJS.Signals): void {
  if (!pgid) return;
  try {
    process.kill(-pgid, sinal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

/** Spawn como o `RunnerCli` (detached, stdin com o prompt e fechado), mas guardando tudo. */
export function iniciarRodada(e: EntradaRodada): RodadaEmCurso {
  const inicio = Date.now();
  const t = () => Date.now() - inicio;
  const filho = spawn('claude', e.args, {
    cwd: e.cwd,
    env: e.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = filho.pid ?? null;
  const controle: ControleRodada = { pid, t, sinalizar: (s) => sinalizarGrupo(pid, s) };
  const linhas: LinhaCrua[] = [];
  const mensagens: MensagemDatada[] = [];
  let stderr = '';
  const divisor = new DivisorLinhas();
  const processar = (linha: string) => {
    const instante = t();
    linhas.push({ t: instante, linha });
    const a = analisarLinha(linha);
    if (a.tipo !== 'mensagem') return;
    mensagens.push({ t: instante, m: a.mensagem });
    try {
      e.aoMensagem?.(a.mensagem, controle);
    } catch (erro) {
      stderr += `\n[spike] aoMensagem lançou: ${String(erro)}\n`;
    }
  };
  filho.stdout.on('data', (c: Buffer) => {
    for (const l of divisor.empurrar(c)) processar(l);
  });
  filho.stderr.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  filho.stdin.on('error', () => undefined);
  filho.stdin.end(e.prompt);
  const teto = setTimeout(() => controle.sinalizar('SIGKILL'), e.timeoutMs ?? 300_000);
  const fim = new Promise<Rodada>((ok) => {
    filho.on('close', (codigo, sinal) => {
      clearTimeout(teto);
      for (const l of divisor.finalizar()) processar(l);
      ok({
        rotulo: e.rotulo,
        args: e.args,
        pid,
        linhas,
        mensagens,
        stderr,
        exitCode: codigo,
        sinal,
        duracaoMs: t(),
      });
    });
  });
  return { controle, processo: filho, fim };
}

export async function rodarClaude(e: EntradaRodada): Promise<Rodada> {
  return iniciarRodada(e).fim;
}

/** Grava o stream bruto (`<spike>/<rotulo>.jsonl` + `.stderr.log`). */
export async function gravarRodada(spike: string, r: Rodada): Promise<string> {
  const dir = join(dirSaida(), spike);
  await mkdir(dir, { recursive: true });
  const base = join(dir, r.rotulo);
  await writeFile(`${base}.jsonl`, r.linhas.map((l) => l.linha).join('\n') + '\n');
  await writeFile(
    `${base}.meta.json`,
    `${JSON.stringify(
      {
        rotulo: r.rotulo,
        args: argsParaRegistro(r.args),
        pid: r.pid,
        exitCode: r.exitCode,
        sinal: r.sinal,
        duracaoMs: r.duracaoMs,
        instantes: r.linhas.map((l) => l.t),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(`${base}.stderr.log`, r.stderr);
  return `${base}.jsonl`;
}

/**
 * Relê uma rodada gravada por `gravarRodada` (ou `null`). Serve para NÃO repetir
 * a rodada cara (Fable + Opus, S2.d) quando o spike é re-executado: 08 §2 pede
 * uma única execução mínima com os modelos de produção.
 */
export function carregarRodada(spike: string, rotulo: string): Rodada | null {
  const base = join(dirSaida(), spike, rotulo);
  if (!existsSync(`${base}.jsonl`) || !existsSync(`${base}.meta.json`)) return null;
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) as {
    args: string[];
    pid: number | null;
    exitCode: number | null;
    sinal: string | null;
    duracaoMs: number;
    instantes: number[];
  };
  const brutas = readFileSync(`${base}.jsonl`, 'utf8').split('\n').filter(Boolean);
  const linhas = brutas.map((linha, i) => ({ t: meta.instantes[i] ?? 0, linha }));
  const mensagens: MensagemDatada[] = [];
  for (const l of linhas) {
    const a = analisarLinha(l.linha);
    if (a.tipo === 'mensagem') mensagens.push({ t: l.t, m: a.mensagem });
  }
  return {
    rotulo,
    args: meta.args,
    pid: meta.pid,
    linhas,
    mensagens,
    stderr: existsSync(`${base}.stderr.log`) ? readFileSync(`${base}.stderr.log`, 'utf8') : '',
    exitCode: meta.exitCode,
    sinal: meta.sinal,
    duracaoMs: meta.duracaoMs,
  };
}

/** argv sem o schema inteiro (o mesmo critério de `registroPerfil`). */
export function argsParaRegistro(args: readonly string[]): string[] {
  return args.map((a, i) =>
    args[i - 1] === '--json-schema' ? `<json-schema ${a.length} bytes>` : a,
  );
}

// ---------------------------------------------------------------------------
// Leitura do stream (puro)
// ---------------------------------------------------------------------------

export interface UsoFerramenta {
  t: number;
  id: string;
  nome: string;
  entrada: Record<string, unknown>;
  /** `parent_tool_use_id` da mensagem (null = thread principal). */
  pai: string | null;
  /** `message.id` do assistant: dois `tool_use` com o mesmo id saíram na mesma mensagem. */
  mensagemId: string | null;
}

export interface ResultadoFerramenta {
  t: number;
  toolUseId: string;
  erro: boolean;
  texto: string;
  pai: string | null;
}

export interface ResumoStream {
  inits: MensagemCli[];
  results: MensagemCli[];
  rateLimits: { t: number; info: Record<string, unknown> }[];
  usos: UsoFerramenta[];
  resultados: ResultadoFerramenta[];
  sistema: { t: number; subtype: string; m: MensagemCli }[];
}

function textoDeConteudo(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        const bloco = b as { type?: string; text?: string };
        return bloco.type === 'text' && typeof bloco.text === 'string' ? bloco.text : '';
      })
      .join('\n');
  }
  return '';
}

export function resumirStream(mensagens: readonly MensagemDatada[]): ResumoStream {
  const r: ResumoStream = {
    inits: [],
    results: [],
    rateLimits: [],
    usos: [],
    resultados: [],
    sistema: [],
  };
  for (const { t, m } of mensagens) {
    const pai = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    if (m.type === 'system') {
      if (m.subtype === 'init') r.inits.push(m);
      else r.sistema.push({ t, subtype: String(m.subtype ?? ''), m });
    } else if (m.type === 'result') {
      r.results.push(m);
    } else if (m.type === 'rate_limit_event') {
      r.rateLimits.push({ t, info: (m.rate_limit_info ?? {}) as Record<string, unknown> });
    } else if (m.type === 'assistant' || m.type === 'user') {
      const msg = (m.message ?? {}) as { id?: string; content?: unknown };
      const blocos = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocos as Record<string, unknown>[]) {
        if (b.type === 'tool_use' && m.type === 'assistant') {
          r.usos.push({
            t,
            id: String(b.id ?? ''),
            nome: String(b.name ?? ''),
            entrada: (b.input ?? {}) as Record<string, unknown>,
            pai,
            mensagemId: typeof msg.id === 'string' ? msg.id : null,
          });
        } else if (b.type === 'tool_result' && m.type === 'user') {
          r.resultados.push({
            t,
            toolUseId: String(b.tool_use_id ?? ''),
            erro: b.is_error === true,
            texto: textoDeConteudo(b.content).slice(0, 2000),
            pai,
          });
        }
      }
    }
  }
  return r;
}

/** Último `result` (maior `result_index`, 01 §6.5). */
export function ultimoResult(r: ResumoStream): MensagemCli | null {
  let ultimo: MensagemCli | null = null;
  for (const m of r.results) {
    const i = typeof m.result_index === 'number' ? m.result_index : 0;
    const j = ultimo && typeof ultimo.result_index === 'number' ? ultimo.result_index : -1;
    if (!ultimo || i >= j) ultimo = m;
  }
  return ultimo;
}

export interface NegacaoResumida {
  ferramenta: string;
  entrada: string;
}

export function negacoesDoResult(result: MensagemCli | null): NegacaoResumida[] {
  const lista = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  return (lista as { tool_name?: string; tool_input?: Record<string, unknown> }[]).map((n) => ({
    ferramenta: String(n.tool_name ?? ''),
    entrada: JSON.stringify(n.tool_input ?? {}),
  }));
}

/** O comando Bash (ou caminho) aparece entre as negações do `result`? */
export function foiNegado(negacoes: readonly NegacaoResumida[], trecho: string): boolean {
  return negacoes.some((n) => n.entrada.includes(trecho));
}

/** Resultado da ferramenta cujo `tool_use` casa com o predicado (o primeiro). */
export function resultadoDe(
  r: ResumoStream,
  casa: (u: UsoFerramenta) => boolean,
): { uso: UsoFerramenta; resultado: ResultadoFerramenta | null } | null {
  const uso = r.usos.find(casa);
  if (!uso) return null;
  return { uso, resultado: r.resultados.find((x) => x.toolUseId === uso.id) ?? null };
}

export function comandoBash(u: UsoFerramenta): string {
  return typeof u.entrada.command === 'string' ? u.entrada.command : '';
}

export function ehAgente(u: UsoFerramenta): boolean {
  return u.nome === 'Agent' || u.nome === 'Task';
}

/** Chaves de `modelUsage` do último result. */
export function modelosUsados(result: MensagemCli | null): string[] {
  const mu = result?.modelUsage;
  return mu && typeof mu === 'object' ? Object.keys(mu).sort() : [];
}

export interface IntervaloNomeado {
  nome: string;
  inicio: number;
  fim: number;
}

/** Dois intervalos se sobrepõem (paralelo) quando um começa antes do outro acabar. */
export function sobrepoem(a: IntervaloNomeado, b: IntervaloNomeado): boolean {
  return a.inicio < b.fim && b.inicio < a.fim;
}

/** Recorte do `rate_limit_event` para comparar antes/depois (S5). */
export interface RecorteCota {
  t: string;
  status: string | null;
  cinco_horas: number | null;
  sete_dias: number | null;
  resetsAt: number | null;
}

export function recorteCota(info: Record<string, unknown>, quando: string): RecorteCota {
  const janelas = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number }>;
  return {
    t: quando,
    status: typeof info.status === 'string' ? info.status : null,
    cinco_horas: janelas.five_hour?.utilization ?? null,
    sete_dias: janelas.seven_day?.utilization ?? null,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
  };
}

/** Uso do `result` (tokens) no que o S5 compara entre processos. */
export function usoDoResult(result: MensagemCli | null): {
  custo: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  input: number | null;
  output: number | null;
} {
  const u = (result?.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    custo: n(result?.total_cost_usd),
    cache_read: n(u.cache_read_input_tokens),
    cache_creation: n(u.cache_creation_input_tokens),
    input: n(u.input_tokens),
    output: n(u.output_tokens),
  };
}

// ---------------------------------------------------------------------------
// Processos (/proc)
// ---------------------------------------------------------------------------

/** pids vivos cujo grupo de processos é `pgid` (lê `/proc/<pid>/stat`). */
export function processosDoGrupo(pgid: number): number[] {
  const vivos: number[] = [];
  for (const nome of readdirSync('/proc')) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const stat = readFileSync(`/proc/${nome}/stat`, 'utf8');
      const resto = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // resto[0] = estado, [1] = ppid, [2] = pgrp.
      if (resto[0] !== 'Z' && Number(resto[2]) === pgid) vivos.push(Number(nome));
    } catch {
      // o processo acabou entre o readdir e a leitura
    }
  }
  return vivos;
}

export interface ProcessoListado {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  comando: string;
}

/** Todos os descendentes vivos de `raiz` (árvore por ppid em `/proc`), com grupo e sessão. */
export function descendentes(raiz: number): ProcessoListado[] {
  const todos: ProcessoListado[] = [];
  for (const nome of readdirSync('/proc')) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const stat = readFileSync(`/proc/${nome}/stat`, 'utf8');
      const resto = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (resto[0] === 'Z') continue;
      const comando = readFileSync(`/proc/${nome}/cmdline`, 'utf8').split('\0').join(' ').trim();
      todos.push({
        pid: Number(nome),
        ppid: Number(resto[1]),
        pgid: Number(resto[2]),
        sid: Number(resto[3]),
        comando: comando.slice(0, 160),
      });
    } catch {
      // acabou entre o readdir e a leitura
    }
  }
  const saida: ProcessoListado[] = [];
  const fila = [raiz];
  while (fila.length) {
    const pai = fila.shift() as number;
    for (const p of todos) {
      if (p.ppid === pai) {
        saida.push(p);
        fila.push(p.pid);
      }
    }
  }
  return saida;
}

export function processoVivo(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

export function esperar(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

export function novoUuid(): string {
  return randomUUID();
}

/**
 * Tira sequências ANSI/OSC e normaliza espaços para procurar texto na tela.
 * Os caracteres de controle nas regex são o próprio alvo (ESC, BEL).
 */
/* eslint-disable no-control-regex */
export function textoDaTela(bruto: string): string {
  return (
    bruto
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      // A TUI desenha espaços movendo o cursor (`CSI n C`): vira espaço para a busca.
      .replace(/\x1b\[\d*C/g, ' ')
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
      .replace(/\x1b[=>78DEHM]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .replace(/[ \t]+/g, ' ')
  );
}
/* eslint-enable no-control-regex */

/** Intervalos `[task_started, task_notification]` por subagente (ms desde o spawn). */
export function intervalosSubagentes(s: ResumoStream): IntervaloNomeado[] {
  const inicio = new Map<string, { t: number; nome: string }>();
  const lista: IntervaloNomeado[] = [];
  for (const x of s.sistema) {
    const id = typeof x.m.tool_use_id === 'string' ? x.m.tool_use_id : null;
    if (!id) continue;
    if (x.subtype === 'task_started') {
      inicio.set(id, { t: x.t, nome: String(x.m.subagent_type ?? x.m.description ?? id) });
    } else if (x.subtype === 'task_notification') {
      const i = inicio.get(id);
      if (i) lista.push({ nome: i.nome, inicio: i.t, fim: x.t });
    }
  }
  return lista;
}
