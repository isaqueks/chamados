import { leitorProcLinux, processosNaRaiz, type LeitorProc } from '../processos/proc-linux';

/**
 * Limpeza de processos do lado do boot/desligamento (specs/forja/01 §3.2).
 *
 * - `varrerCwd`: depois de matar um agente, os comandos do Bash dele (dev
 *   server, watcher de teste) sobrevivem fora do `pgid` [V S4] — mata quem
 *   tem `cwd` dentro da worktree, poupando os PTYs abertos pelo usuário.
 * - `encerrarDescendentes`: rede de segurança do desligamento. Mesmo com o
 *   orquestrador e o gerente de PTY parados, um filho em grupo próprio
 *   (`detached`) não recebe o sinal do grupo do Node; aqui a árvore inteira de
 *   descendentes (por `ppid` em `/proc`) leva SIGTERM e, se sobrar, SIGKILL —
 *   "nenhum filho de antes sobrevive sem dono" (01 §3.2, A5).
 */

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sinalizar(pid: number, sinal: NodeJS.Signals): void {
  try {
    process.kill(pid, sinal);
  } catch {
    // ESRCH: já saiu.
  }
}

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGTERM em todos, espera até `esperaMs`, SIGKILL em quem sobrou. Devolve quantos eram. */
export async function encerrarPids(pids: readonly number[], esperaMs = 3000): Promise<number> {
  const alvos = pids.filter((p) => p > 1 && p !== process.pid);
  if (alvos.length === 0) return 0;
  for (const p of alvos) sinalizar(p, 'SIGTERM');
  const limite = Date.now() + esperaMs;
  while (Date.now() < limite && alvos.some(vivo)) await dormir(50);
  for (const p of alvos) if (vivo(p)) sinalizar(p, 'SIGKILL');
  return alvos.length;
}

/** Varredura do cwd (01 §3.2 [V S4]); `sessoesProtegidas` = `sid` dos PTYs do usuário. */
export async function varrerCwd(
  dir: string,
  sessoesProtegidas: () => ReadonlySet<number>,
  leitor: LeitorProc = leitorProcLinux,
): Promise<number> {
  const pids = processosNaRaiz(dir, { leitor, sessoesProtegidas: sessoesProtegidas() });
  return encerrarPids(pids);
}

/** Descendentes de `raiz` (filhos, netos…) lendo `ppid` em `/proc`. */
export function descendentes(raiz: number, leitor: LeitorProc = leitorProcLinux): number[] {
  const filhosDe = new Map<number, number[]>();
  for (const pid of leitor.pids()) {
    const ppid = leitor.stat(pid)?.ppid;
    if (ppid === undefined) continue;
    const lista = filhosDe.get(ppid) ?? [];
    lista.push(pid);
    filhosDe.set(ppid, lista);
  }
  const saida: number[] = [];
  const pilha = [...(filhosDe.get(raiz) ?? [])];
  while (pilha.length > 0) {
    const p = pilha.pop()!;
    if (saida.includes(p)) continue;
    saida.push(p);
    pilha.push(...(filhosDe.get(p) ?? []));
  }
  return saida;
}

/** Último degrau do desligamento: nenhum descendente do Node fica vivo. */
export async function encerrarDescendentes(
  leitor: LeitorProc = leitorProcLinux,
  esperaMs = 3000,
): Promise<number> {
  return encerrarPids(descendentes(process.pid, leitor), esperaMs);
}
