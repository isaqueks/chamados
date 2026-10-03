import { join } from 'node:path';

/**
 * `bwrap` do MODO REFORÇADO (specs/forja/05 §5.2) [NV S6] — só a MONTAGEM do
 * comando. Até FJ-032 confinava a verificação pelo app; desde então a Forja não
 * executa comandos do projeto e o pipeline não o usa (o modo reforçado é o
 * sandbox da CLI no T1). Mantido para o spike S6 e um uso futuro.
 *
 * O que a montagem garante (05 §5.2):
 * - `/` somente leitura, `$HOME` em tmpfs (some `~/.ssh`, `~/.config/gh`,
 *   `~/.claude`, os outros repositórios sob o home e o diretório de dados da
 *   Forja), `/tmp` próprio;
 * - a worktree com bind de escrita; o `.git` do repositório principal só
 *   leitura (config e hooks intocáveis), exceto o diretório de metadados DESTA
 *   worktree (`.git/worktrees/<nome>`: índice e HEAD);
 * - caches de toolchain (`~/.npm`, `~/.nvm`…) só leitura, reexpostos dentro do
 *   tmpfs do home;
 * - processo morre com o pai e numa sessão nova (sem TIOCSTI no terminal).
 *
 * Rede: "só 127.0.0.1 e as portas declaradas" NÃO é expressável no bwrap puro —
 * `--unshare-net` cria um loopback próprio e corta também o Postgres do host.
 * Por isso a rede tem dois modos: `compartilhada` (padrão, sem isolamento) e
 * `isolada` (`--unshare-net`, sem rede nenhuma). O encaminhamento por socket
 * Unix (`socat`, plano B do S6) fica para quando o S6 decidir.
 * TODO(S6): validar a montagem nesta máquina (`apparmor_restrict_unprivileged_userns = 1`)
 * e o plano B de rede antes de expor o modo reforçado na UI.
 */

export interface OpcoesBwrap {
  /** Worktree (bind de escrita, cwd). */
  worktree: string;
  /** `.git` comum do repositório principal (`git rev-parse --git-common-dir`). */
  dirGitComum: string;
  /** Diretório de metadados desta worktree (`git rev-parse --git-dir`), gravável. */
  dirGitWorktree: string;
  home: string;
  /** Caminhos absolutos de caches só leitura (ex.: `~/.npm`, `~/.nvm`). */
  cachesSomenteLeitura?: readonly string[];
  rede?: 'compartilhada' | 'isolada';
  /** Executável (teste/Diagnóstico). */
  binario?: string;
}

/** argv `bwrap … -- <argv>` (05 §5.2). Pura: não confere se os caminhos existem. */
export function montarComandoBwrap(argv: readonly string[], o: OpcoesBwrap): string[] {
  const args: string[] = [
    o.binario ?? 'bwrap',
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    o.home,
  ];
  for (const cache of o.cachesSomenteLeitura ?? []) args.push('--ro-bind-try', cache, cache);
  args.push('--ro-bind', o.dirGitComum, o.dirGitComum);
  args.push('--bind', o.dirGitWorktree, o.dirGitWorktree);
  args.push('--bind', o.worktree, o.worktree);
  if ((o.rede ?? 'compartilhada') === 'isolada') args.push('--unshare-net');
  args.push('--setenv', 'HOME', o.home, '--setenv', 'TMPDIR', '/tmp');
  args.push('--chdir', o.worktree, '--', ...argv);
  return args;
}

/** Caches comuns de toolchain sob o home (só leitura dentro do bwrap). */
export function cachesPadrao(home: string): string[] {
  return ['.npm', '.nvm', '.cache/ms-playwright', '.cache/node', '.local/share/pnpm'].map((c) =>
    join(home, c),
  );
}

/** Falha de montagem do próprio bwrap (→ classificação `ambiente`, 03 §5.2). */
export function ehErroDoBwrap(cauda: string): boolean {
  return /^bwrap: /m.test(cauda);
}

/** Envolve um argv num confinador (modo reforçado). */
export interface Confinador {
  envolver(argv: readonly string[], ctx: { cwd: string }): string[];
  /** A falha veio do próprio confinador? */
  ehErroDoConfinador(cauda: string, exitCode: number | null): boolean;
}

/**
 * `Confinador` `bwrap` (05 §5.2). Desde FJ-032 o pipeline não executa comandos
 * do projeto, então nada o usa hoje; fica para um comando do app que precise
 * de confinamento (e para o spike S6).
 */
export function confinadorBwrap(o: Omit<OpcoesBwrap, 'worktree'>): Confinador {
  return {
    envolver: (argv, ctx) => montarComandoBwrap(argv, { ...o, worktree: ctx.cwd }),
    ehErroDoConfinador: (cauda) => ehErroDoBwrap(cauda),
  };
}
