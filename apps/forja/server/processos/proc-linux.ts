import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Leitura de `/proc` para o supervisor e a reconciliação (specs/forja/01 §3.2,
 * §6.7; 03 §11). POR QUE conferir `cmdline` e `pgid` antes de sinalizar: o
 * `pid` gravado no SQLite pode ter sido reutilizado pelo kernel depois de um
 * crash do app; mandar SIGKILL para `-pgid` sem conferir mataria o grupo de
 * outro programa do usuário. O kernel não reaproveita um número enquanto ele é
 * `pgid`/`sid` de alguém, então:
 *
 * - `pid` existe, `cmdline` é o esperado e `pgid` bate → é nosso (`vivo`);
 * - `pid` não existe mas o grupo responde a `kill(-pgid, 0)` → sobraram filhos
 *   do nosso grupo (o líder morreu) → `grupo_orfao`, também é nosso;
 * - `pid` existe com outro comando ou outro grupo → o número foi reutilizado
 *   (o nosso grupo já estava vazio) → `pid_reutilizado`, NÃO sinalizar;
 * - nada responde → `morto`.
 *
 * Tudo atrás de `LeitorProc` para os testes simularem `/proc` sem processos.
 */

export interface StatProc {
  ppid: number;
  pgid: number;
  /** Sessão (`setsid`): um PTY é líder da própria sessão. */
  sid: number;
}

export interface LeitorProc {
  /** argv do processo, ou null se não existe/não é legível. */
  cmdline(pid: number): string[] | null;
  stat(pid: number): StatProc | null;
  /** Destino de `/proc/<pid>/cwd`, ou null (outro UID, processo sumiu). */
  cwd(pid: number): string | null;
  /** Todos os pids numéricos em `/proc`. */
  pids(): number[];
}

/**
 * `/proc/<pid>/stat`: `pid (comm) estado ppid pgrp sessão …`. O `comm` pode ter
 * espaços e parênteses, por isso o corte é no ÚLTIMO `)`.
 */
export function interpretarStat(conteudo: string): StatProc | null {
  const fim = conteudo.lastIndexOf(')');
  if (fim < 0) return null;
  const campos = conteudo
    .slice(fim + 2)
    .trim()
    .split(/\s+/);
  const [, ppid, pgid, sid] = campos.map(Number);
  if (![ppid, pgid, sid].every((n) => Number.isInteger(n))) return null;
  return { ppid: ppid!, pgid: pgid!, sid: sid! };
}

export function interpretarCmdline(conteudo: Buffer | string): string[] {
  const texto = typeof conteudo === 'string' ? conteudo : conteudo.toString('utf8');
  return texto.split('\0').filter((p) => p.length > 0);
}

export const leitorProcLinux: LeitorProc = {
  cmdline(pid) {
    try {
      const argv = interpretarCmdline(readFileSync(`/proc/${pid}/cmdline`));
      return argv.length > 0 ? argv : null; // zumbi/kernel thread: cmdline vazio
    } catch {
      return null;
    }
  },
  stat(pid) {
    try {
      return interpretarStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return null;
    }
  },
  cwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  pids() {
    try {
      return readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
  },
};

/** Interpretadores que aparecem como argv[0] quando o comando é um script com shebang. */
const INTERPRETADORES: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'sh',
  'bash',
]);

/**
 * O argv é do comando esperado? Aceita o binário direto (`claude`, `/bin/sh`)
 * ou um interpretador rodando o script (`node /…/bin/claude`).
 */
export function confereComando(argv: readonly string[], esperado: string): boolean {
  const alvo = basename(esperado);
  const a0 = argv[0] ? basename(argv[0]) : '';
  if (a0 === alvo) return true;
  if (INTERPRETADORES.has(a0) && argv[1] && basename(argv[1]) === alvo) return true;
  return false;
}

/** `kill(-pgid, 0)`: há algum processo no grupo? EPERM = existe (de outro UID). */
export function grupoVivo(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (erro) {
    return (erro as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type EstadoSondado = 'vivo' | 'grupo_orfao' | 'pid_reutilizado' | 'morto';

export interface ProcessoParaSondar {
  pid: number;
  pgid: number;
  /** Comando esperado (`claude`, `sh`, `git`). */
  comando: string;
}

export interface DepsSonda {
  leitor?: LeitorProc;
  grupoVivo?: (pgid: number) => boolean;
}

/** Classifica um processo registrado antes de qualquer sinal (regras no topo). */
export function sondarProcesso(alvo: ProcessoParaSondar, deps: DepsSonda = {}): EstadoSondado {
  const leitor = deps.leitor ?? leitorProcLinux;
  const temGrupo = deps.grupoVivo ?? grupoVivo;
  const argv = leitor.cmdline(alvo.pid);
  if (argv === null) {
    return temGrupo(alvo.pgid) ? 'grupo_orfao' : 'morto';
  }
  const st = leitor.stat(alvo.pid);
  if (confereComando(argv, alvo.comando) && st?.pgid === alvo.pgid) return 'vivo';
  return 'pid_reutilizado';
}

/** `estaVivo(pid)` de 01 §6.7: vivo E é o nosso comando no nosso grupo. */
export function estaVivo(alvo: ProcessoParaSondar, deps: DepsSonda = {}): boolean {
  return sondarProcesso(alvo, deps) === 'vivo';
}

/** `caminho` está dentro de `raiz` (ou é ela)? Comparação por segmento, não por prefixo cru. */
export function dentroDe(caminho: string, raiz: string): boolean {
  const r = raiz.endsWith('/') ? raiz.slice(0, -1) : raiz;
  return caminho === r || caminho.startsWith(`${r}/`);
}

export interface OpcoesVarredura {
  leitor?: LeitorProc;
  /** Sessões (`sid`) a nunca tocar: os PTYs abertos do usuário (01 §11). */
  sessoesProtegidas?: ReadonlySet<number>;
  /** Pids a nunca tocar (o próprio app e seus ancestrais entram sempre). */
  pidsProtegidos?: ReadonlySet<number>;
}

/**
 * Processos com `cwd` dentro de `raiz` (01 §3.2: "varre `/proc/*\/cwd` dentro
 * da worktree para matar sobras (dev servers)" [NV → S4]). Exclui o próprio
 * Node, seus ancestrais e as sessões protegidas (um `claude` livre aberto pelo
 * usuário naquela worktree não é sobra).
 */
export function processosNaRaiz(raiz: string, opcoes: OpcoesVarredura = {}): number[] {
  const leitor = opcoes.leitor ?? leitorProcLinux;
  const protegidos = new Set<number>(opcoes.pidsProtegidos ?? []);
  protegidos.add(process.pid);
  let ancestral = process.ppid;
  for (let i = 0; i < 64 && ancestral > 1 && !protegidos.has(ancestral); i += 1) {
    protegidos.add(ancestral);
    ancestral = leitor.stat(ancestral)?.ppid ?? 0;
  }
  const achados: number[] = [];
  for (const pid of leitor.pids()) {
    if (pid <= 1 || protegidos.has(pid)) continue;
    const cwd = leitor.cwd(pid);
    if (cwd === null || !dentroDe(cwd, raiz)) continue;
    const sid = leitor.stat(pid)?.sid;
    if (sid !== undefined && opcoes.sessoesProtegidas?.has(sid)) continue;
    achados.push(pid);
  }
  return achados;
}
