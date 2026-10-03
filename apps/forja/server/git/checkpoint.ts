import { ErroGit, git, shaHead, statusPorcelain } from './git';

/**
 * Commit de checkpoint pelo app (specs/forja/01 §9.2, 03 §3.3, F-08).
 *
 * POR QUE só o app commita: o diff que avança no pipeline é o que o app
 * registrou, com `core.hooksPath=/dev/null` (um hook plantado pelo agente
 * rodaria no commit). O checkpoint é um SNAPSHOT, não unidade semântica: com
 * implementadores paralelos ele pode pegar a edição parcial do outro, e o
 * próximo completa.
 *
 * Só commita se a árvore mudou (`status --porcelain` não vazio): commit vazio
 * mudaria o `sha` e invalidaria à toa o veredito e o nível de verificação, que
 * valem para o `sha` em que foram produzidos (03 §2.5, §3.3).
 *
 * O agente roda `git status`/`git diff` na mesma worktree e pode estar segurando
 * o `index.lock`: a disputa vira nova tentativa após 1 s, até 5 (03 §3.3).
 */

export const MENSAGEM_RECUPERADO = 'forja: recuperado após interrupção';
export const MENSAGEM_AO_INTERROMPER = 'forja: estado ao interromper';
export const MENSAGEM_MANUAL = 'forja: alterações manuais';

/** `forja: passo <k> (#<n>)` (01 §9.2). */
export function mensagemPasso(passo: string | number, numeroChamado: number): string {
  return `forja: passo ${passo} (#${numeroChamado})`;
}

export interface OpcoesCheckpoint {
  /** Tentativas contra `index.lock` (padrão 5). */
  tentativas?: number;
  /** Espera entre tentativas (padrão 1 s). */
  esperaMs?: number;
  /** Injetável no teste. */
  dormir?: (ms: number) => Promise<void>;
  /**
   * Caminhos que NUNCA entram no commit (destinos de `arquivos_locais`: `.env`,
   * `config.local.json`…), mesmo que o repositório não os ignore ou que o
   * agente os tenha tirado do `.gitignore` (05 §8.1).
   */
  excluir?: readonly string[];
  /**
   * Branch da execução: o HEAD da worktree TEM de estar nela. Um `git switch`/
   * `branch -f` do agente faria o commit avançar outra ref (ex.: `main`) com
   * código não aprovado (05 §9) → `ErroCheckpointBranch`, nada é commitado.
   */
  branch?: string | null;
}

export class ErroCheckpointBranch extends Error {
  constructor(
    readonly esperada: string,
    readonly atual: string | null,
  ) {
    super(
      `o HEAD da worktree saiu da branch da execução (esperado ${esperada}, encontrado ${atual ?? 'HEAD destacado'})`,
    );
    this.name = 'ErroCheckpointBranch';
  }
}

/** `refs/heads/<branch>` em que o HEAD da worktree está (null = destacado). */
export async function refDoHead(dir: string): Promise<string | null> {
  const r = await git(['symbolic-ref', '-q', 'HEAD'], { cwd: dir, aceitar: [0, 1, 128] });
  return r.codigo === 0 ? r.stdout.trim() || null : null;
}

/** Pathspec literal que exclui um caminho (sem glob/magia vinda da config). */
function pathspecExcluir(caminho: string): string {
  return `:(exclude,literal)${caminho.replace(/^\.\//, '')}`;
}

export interface Checkpoint {
  sha: string;
  mensagem: string;
  /** Entradas do `status --porcelain` capturadas (≈ arquivos tocados). */
  arquivos: number;
}

const dormirPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ehDisputaDeLock(e: unknown): boolean {
  return e instanceof ErroGit && /index\.lock/.test(e.stderr);
}

async function comRetentativa<T>(fn: () => Promise<T>, opcoes: OpcoesCheckpoint): Promise<T> {
  const tentativas = opcoes.tentativas ?? 5;
  const dormir = opcoes.dormir ?? dormirPadrao;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!ehDisputaDeLock(e) || i >= tentativas) throw e;
      await dormir(opcoes.esperaMs ?? 1000);
    }
  }
}

/**
 * `git add -A` + `git commit -m <mensagem>` na worktree, só se houver mudança.
 * Devolve `null` quando a árvore está limpa (nenhum commit feito).
 */
export async function commitCheckpoint(
  dir: string,
  mensagem: string,
  opcoes: OpcoesCheckpoint = {},
): Promise<Checkpoint | null> {
  if (opcoes.branch) {
    const esperada = `refs/heads/${opcoes.branch}`;
    const atual = await refDoHead(dir);
    if (atual !== esperada) throw new ErroCheckpointBranch(esperada, atual);
  }
  const mudancas = await statusPorcelain(dir);
  if (mudancas.length === 0) return null;
  const excluir = (opcoes.excluir ?? []).filter((c) => c.trim().length > 0);
  await comRetentativa(
    () =>
      git(
        excluir.length ? ['add', '-A', '--', '.', ...excluir.map(pathspecExcluir)] : ['add', '-A'],
        {
          cwd: dir,
        },
      ),
    opcoes,
  );
  // Algo já preparado por fora (`git add .env` do agente): tirado do índice.
  if (excluir.length) {
    const preparados = (await git(['diff', '--cached', '--name-only', '-z'], { cwd: dir })).stdout
      .split('\0')
      .filter(Boolean);
    const indevidos = preparados.filter((p) => excluir.some((c) => p === c.replace(/^\.\//, '')));
    if (indevidos.length) {
      await comRetentativa(
        () => git(['reset', '-q', '--', ...indevidos.map((p) => `:(literal)${p}`)], { cwd: dir }),
        opcoes,
      );
    }
  }
  // `status` pode listar algo que não vira mudança no índice (ex.: só modo com
  // `core.fileMode=false`): sem nada preparado, não há commit.
  const preparado = await git(['diff', '--cached', '--quiet'], { cwd: dir, aceitar: [0, 1] });
  if (preparado.codigo === 0) return null;
  await comRetentativa(
    () => git(['commit', '--no-verify', '--quiet', '-m', mensagem], { cwd: dir }),
    opcoes,
  );
  return { sha: await shaHead(dir), mensagem, arquivos: mudancas.length };
}
