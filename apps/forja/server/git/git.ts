import { spawn } from 'node:child_process';

/**
 * Execução de `git` pelo app (specs/forja/01 §9.2, 05 §9, 03 §8.1).
 *
 * POR QUE um único ponto de entrada: TODO git da Forja roda contra repositórios
 * em que um agente sem sandbox escreveu (U-3). O repositório pode trazer hooks,
 * `core.fsmonitor` (que executa um programa a cada `status`) e config plantada.
 * Por isso cada chamada leva `-c core.hooksPath=/dev/null -c core.fsmonitor=false`
 * na frente de qualquer subcomando, sem exceção e sem opção de desligar.
 *
 * Env: construído do zero (nunca `{...process.env}` menos algo, 01 §6.1). O git
 * do app mantém `HOME` (identidade e `~/.gitconfig` do usuário) e
 * `SSH_AUTH_SOCK` (push por SSH), mas nunca tokens (`GH_TOKEN`, `CHAMADOS_*`…).
 * `LC_ALL=C` estabiliza as mensagens que o app interpreta (rejeição de push,
 * conflito, `index.lock`); `GIT_TERMINAL_PROMPT=0` impede o git de travar
 * pedindo senha num terminal que não existe.
 *
 * Erro sem vazar credencial: o push pode usar uma URL `https://user:token@host`
 * (03 §8.2). Toda mensagem de erro e toda saída devolvida passa por
 * `redigirCredenciais`, que troca o userinfo da URL e os segredos conhecidos por
 * `«redigido»` (05 §8.2) — o argv nunca é incluído na mensagem de erro.
 */

/** Prefixo obrigatório de todo git do app (01 §9.2, 05 §9). */
export const CONFIG_GIT_SEGURA: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

export const REDIGIDO = '«redigido»';

const TIMEOUT_PADRAO_MS = 120_000;

/** Variáveis herdadas do processo do app pelo git (allowlist de 01 §6.1 + SSH_AUTH_SOCK). */
const ENV_HERDADO = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK'];

export interface OpcoesGit {
  /** Diretório onde o git roda (`-C` não é usado: cwd explícito). */
  cwd: string;
  /** Entrada enviada pelo stdin (ex.: `patch-id`). */
  stdin?: string;
  timeoutMs?: number;
  /** Códigos de saída aceitos sem lançar (ex.: `[0, 1]` em `merge-base --is-ancestor`). */
  aceitar?: readonly number[];
  /** Segredos conhecidos a redigir da saída e do erro (05 §8.2). */
  segredos?: readonly string[];
  /** Variáveis extras (ex.: `GIT_OPTIONAL_LOCKS`). Nunca credenciais. */
  envExtra?: Record<string, string>;
  /** Base do env (testes); padrão `process.env`, filtrado pela allowlist. */
  envBase?: NodeJS.ProcessEnv;
}

export interface ResultadoGit {
  codigo: number;
  stdout: string;
  stderr: string;
}

/** Falha de git: mensagem já redigida, nunca com o argv nem com URL autenticada. */
export class ErroGit extends Error {
  constructor(
    /** Subcomando (ex.: `push`, `merge`), sem argumentos. */
    readonly subcomando: string,
    readonly codigo: number | null,
    readonly stderr: string,
    mensagem?: string,
  ) {
    super(mensagem ?? `git ${subcomando} falhou (exit ${codigo ?? 'sinal'}): ${resumir(stderr)}`);
    this.name = 'ErroGit';
  }
}

function resumir(texto: string): string {
  const linhas = texto.trim().split('\n').filter(Boolean);
  return linhas.slice(-3).join(' | ').slice(0, 500) || '(sem saída)';
}

/**
 * Remove credenciais de um texto: userinfo de URLs (`https://u:s@h` →
 * `https://«redigido»@h`) e cada segredo conhecido.
 */
export function redigirCredenciais(texto: string, segredos: readonly string[] = []): string {
  let saida = texto.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDIGIDO}@`);
  for (const segredo of segredos) {
    if (segredo.length >= 4) saida = saida.split(segredo).join(REDIGIDO);
  }
  return saida;
}

/** Env limpo do git do app (01 §6.1, 05 §9). */
export function envGit(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(base)) {
    if (valor === undefined) continue;
    if (ENV_HERDADO.includes(chave) || chave.startsWith('LC_')) env[chave] = valor;
  }
  return {
    ...env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    // Leituras (`status`) não disputam o `index.lock` com o agente (03 §3.3).
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

/** Primeiro argumento que não é opção global (pula `-c <valor>`). Só o nome vai para erros. */
function nomeSubcomando(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-c') i++;
    else if (!a.startsWith('-')) return a;
  }
  return 'git';
}

/** Executa `git <CONFIG_GIT_SEGURA> <args>`. Lança `ErroGit` fora de `aceitar` (padrão `[0]`). */
export function git(args: readonly string[], opcoes: OpcoesGit): Promise<ResultadoGit> {
  const aceitar = opcoes.aceitar ?? [0];
  const segredos = opcoes.segredos ?? [];
  const subcomando = nomeSubcomando(args);
  return new Promise((resolver, rejeitar) => {
    const filho = spawn('git', [...CONFIG_GIT_SEGURA, ...args], {
      cwd: opcoes.cwd,
      env: envGit(opcoes.envBase, opcoes.envExtra),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let estourou = false;
    const timer = setTimeout(() => {
      estourou = true;
      filho.kill('SIGKILL');
    }, opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS);
    filho.stdout.on('data', (b: Buffer) => out.push(b));
    filho.stderr.on('data', (b: Buffer) => err.push(b));
    filho.on('error', (e) => {
      clearTimeout(timer);
      rejeitar(new ErroGit(subcomando, null, '', `git indisponível: ${e.message}`));
    });
    filho.on('close', (codigo) => {
      clearTimeout(timer);
      const stdout = redigirCredenciais(Buffer.concat(out).toString('utf8'), segredos);
      const stderr = redigirCredenciais(Buffer.concat(err).toString('utf8'), segredos);
      if (estourou) {
        rejeitar(new ErroGit(subcomando, null, stderr, `git ${subcomando}: tempo esgotado`));
        return;
      }
      const c = codigo ?? -1;
      if (!aceitar.includes(c)) {
        rejeitar(new ErroGit(subcomando, c, stderr));
        return;
      }
      resolver({ codigo: c, stdout, stderr });
    });
    filho.stdin.on('error', () => {
      // EPIPE se o git sair antes de ler tudo: o código de saída diz o resto.
    });
    filho.stdin.end(opcoes.stdin ?? '');
  });
}

/** `git rev-parse --verify <ref>^{commit}` → sha completo, ou `null` se não existe. */
export async function resolverSha(cwd: string, ref: string): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd,
    aceitar: [0, 1, 128],
  });
  return r.codigo === 0 ? r.stdout.trim() : null;
}

/** HEAD da árvore (lança se não houver commit). */
export async function shaHead(cwd: string): Promise<string> {
  const sha = await resolverSha(cwd, 'HEAD');
  if (!sha) throw new ErroGit('rev-parse', 1, '', `HEAD inexistente em ${cwd}`);
  return sha;
}

/**
 * Linhas de `git status --porcelain` (vazio = árvore limpa). `incluirNaoRastreados = false`
 * considera só arquivos rastreados (ex.: decidir se a cópia do usuário está "suja").
 */
export async function statusPorcelain(cwd: string, incluirNaoRastreados = true): Promise<string[]> {
  const r = await git(
    ['status', '--porcelain', `--untracked-files=${incluirNaoRastreados ? 'all' : 'no'}`],
    { cwd },
  );
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

export async function arvoreLimpa(cwd: string): Promise<boolean> {
  return (await statusPorcelain(cwd)).length === 0;
}

/** `git merge-base --is-ancestor <a> <b>`: `a` já está contido em `b`? (03 §9.5). */
export async function ehAncestral(cwd: string, a: string, b: string): Promise<boolean> {
  const r = await git(['merge-base', '--is-ancestor', a, b], { cwd, aceitar: [0, 1] });
  return r.codigo === 0;
}

/** Diretório comum (`.git` do repositório principal), absoluto. */
export async function dirGitComum(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return r.stdout.trim();
}
