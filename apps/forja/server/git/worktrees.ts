import { cp, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { slugChamado } from '@chamados/shared';
import { ErroGit, git, resolverSha } from './git';

/**
 * Worktree manager (specs/forja/01 §9.1, 02 §7, 03 §5.4 e §8.1).
 *
 * Cada execução trabalha numa worktree própria, criada a partir da branch de
 * destino, FORA do repositório do usuário (`<dados>/worktrees/<projeto>/<n>-<exec8>`):
 * a cópia do usuário nunca é tocada (F-10). A branch tem prefixo `forja/` para
 * não colidir com o `ia/chamado-<n>-*` da IA do servidor; se já existir, ganha
 * sufixo `-r2`, `-r3`… — nunca é reescrita.
 *
 * `arquivos_locais` (ex.: `.env`) são COPIADOS, nunca linkados: um symlink
 * deixaria o agente (em bypass, U-3) editar o arquivo do usuário. A cópia segue
 * symlinks da origem (copia o conteúdo) e, se o destino na worktree já for um
 * symlink versionado, ele é removido antes — senão a escrita iria para o alvo.
 *
 * Worktrees destacadas (`--detach`) servem à integração da fila de merge
 * (`_integracao/<item8>`) e ao `evidenciar antes` tardio em `sha_base`
 * (`_integracao/base-<exec8>`): ficam sob `_integracao/`, que já está no `deny`
 * dos agentes (02 §7), e são removidas ao fim.
 *
 * A remoção só aceita caminhos dentro de `<dados>/worktrees/`: a função nunca
 * apaga a cópia do usuário nem nada fora do diretório de dados.
 */

export interface ArquivoLocal {
  origem: string;
  destino: string;
  modo: 'copiar';
}

/** `<dados>/worktrees/<slug>` (02 §7). */
export function dirWorktreesProjeto(dirDados: string, projetoSlug: string): string {
  return join(dirDados, 'worktrees', projetoSlug);
}

/** `<dados>/worktrees/<slug>/<n>-<exec8>` (02 §7). */
export function caminhoWorktreeExecucao(
  dirDados: string,
  projetoSlug: string,
  numero: number,
  execucaoId: string,
): string {
  return join(dirWorktreesProjeto(dirDados, projetoSlug), `${numero}-${prefixo8(execucaoId)}`);
}

/** `<dados>/worktrees/<slug>/_integracao/<item8>` (02 §7, 03 §8.1). */
export function caminhoWorktreeIntegracao(
  dirDados: string,
  projetoSlug: string,
  itemId: string,
): string {
  return join(dirWorktreesProjeto(dirDados, projetoSlug), '_integracao', prefixo8(itemId));
}

/** Worktree temporária em `sha_base` para o `evidenciar antes` tardio (03 §5.4). */
export function caminhoWorktreeBase(
  dirDados: string,
  projetoSlug: string,
  execucaoId: string,
): string {
  return join(
    dirWorktreesProjeto(dirDados, projetoSlug),
    '_integracao',
    `base-${prefixo8(execucaoId)}`,
  );
}

function prefixo8(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** `forja/chamado-<n>-<slug>` com o prefixo do projeto (F-09, 02 §4.2). */
export function nomeBranchExecucao(prefixo: string, numero: number, titulo: string): string {
  return `${prefixo}chamado-${numero}-${slugChamado(titulo)}`;
}

/** Caminho relativo seguro (sem absoluto, sem `..`) — recusa o resto. */
export function caminhoRelativoSeguro(caminho: string): string {
  const n = normalize(caminho);
  if (!caminho.trim() || isAbsolute(caminho) || n === '..' || n.startsWith(`..${sep}`)) {
    throw new Error(`caminho de arquivo local inválido: "${caminho}"`);
  }
  return n;
}

function dentroDe(raiz: string, caminho: string): boolean {
  const r = relative(resolve(raiz), resolve(caminho));
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

export interface EntradaCriarWorktree {
  repoDir: string;
  dirDados: string;
  projetoSlug: string;
  execucaoId: string;
  numero: number;
  titulo: string;
  branchDestino: string;
  prefixoBranch: string;
  arquivosLocais: readonly ArquivoLocal[];
}

export interface WorktreeCriada {
  dir: string;
  branch: string;
  shaBase: string;
  /** Arquivos locais efetivamente copiados (relativos à worktree). */
  copiados: string[];
  /** Ex.: origem ausente na cópia do usuário (não bloqueia; vira aviso no feed). */
  avisos: string[];
}

/**
 * `worktree add -b <branch> <dir> <destino>` + `worktree lock` + cópia dos
 * `arquivos_locais` (01 §9.1). Grava `sha_base` = commit do destino usado.
 */
export async function criarWorktreeExecucao(e: EntradaCriarWorktree): Promise<WorktreeCriada> {
  const shaBase = await resolverSha(e.repoDir, `refs/heads/${e.branchDestino}`);
  if (!shaBase) {
    throw new ErroGit('worktree', null, '', `branch de destino inexistente: ${e.branchDestino}`);
  }
  const dir = caminhoWorktreeExecucao(e.dirDados, e.projetoSlug, e.numero, e.execucaoId);
  const branch = await branchLivre(
    e.repoDir,
    nomeBranchExecucao(e.prefixoBranch, e.numero, e.titulo),
  );
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await git(['worktree', 'add', '-b', branch, dir, shaBase], { cwd: e.repoDir });
  await git(['worktree', 'lock', '--reason', `forja:${e.execucaoId}`, dir], { cwd: e.repoDir });
  const { copiados, avisos } = await copiarArquivosLocais(e.repoDir, dir, e.arquivosLocais);
  const sub = await copiarSubmodulosPopulados(e.repoDir, dir);
  copiados.push(...sub.copiados);
  avisos.push(...sub.avisos);
  return { dir, branch, shaBase, copiados, avisos };
}

/**
 * Submódulos (gitlinks, modo 160000) NÃO vêm no `git worktree add`; quando o
 * `.gitmodules` não existe (repo-alvo com submódulos "soltos"), nem o
 * `submodule update --init` resolve. Caso real de 2026-10-03 (chamado #56): o
 * implementador perdeu `api-backend/lib/naeb` e `common/lib/validateit` e
 * precisou de shims. Solução prática: copiar do checkout do usuário o conteúdo
 * de cada gitlink que lá esteja populado (sem o `.git` interno, para a worktree
 * não virar repo aninhado). Ausentes no checkout viram aviso, nunca erro.
 */
export async function copiarSubmodulosPopulados(
  repoDir: string,
  worktreeDir: string,
): Promise<{ copiados: string[]; avisos: string[] }> {
  const copiados: string[] = [];
  const avisos: string[] = [];
  const saida = await git(['ls-files', '-s'], { cwd: repoDir }).catch(() => '');
  for (const linha of String(saida).split('\n')) {
    if (!linha.startsWith('160000 ')) continue;
    const rel = linha.split('\t')[1]?.trim();
    if (!rel) continue;
    const origem = join(repoDir, caminhoRelativoSeguro(rel));
    const destino = join(worktreeDir, caminhoRelativoSeguro(rel));
    const tem = await stat(join(origem)).then(
      (st) => st.isDirectory(),
      () => false,
    );
    const populado = tem && (await readdir(origem)).some((n) => n !== '.git');
    if (!populado) {
      avisos.push(`submódulo não populado no checkout do usuário: ${rel}`);
      continue;
    }
    await rm(destino, { recursive: true, force: true });
    await mkdir(dirname(destino), { recursive: true });
    await cp(origem, destino, {
      recursive: true,
      dereference: true,
      force: true,
      errorOnExist: false,
      filter: (src) => !src.split('/').includes('.git'),
    });
    copiados.push(rel);
  }
  return { copiados, avisos };
}

/** Primeiro nome livre entre `<base>`, `<base>-r2`, `<base>-r3`… (nunca reescreve). */
export async function branchLivre(repoDir: string, base: string): Promise<string> {
  for (let k = 1; k < 100; k++) {
    const nome = k === 1 ? base : `${base}-r${k}`;
    if (!(await resolverSha(repoDir, `refs/heads/${nome}`))) return nome;
  }
  throw new ErroGit('branch', null, '', `sem nome livre para a branch ${base}`);
}

/** Copia (nunca symlink) os arquivos não versionados declarados no projeto (01 §9.1). */
export async function copiarArquivosLocais(
  repoDir: string,
  worktreeDir: string,
  arquivos: readonly ArquivoLocal[],
): Promise<{ copiados: string[]; avisos: string[] }> {
  const copiados: string[] = [];
  const avisos: string[] = [];
  for (const arquivo of arquivos) {
    const origem = join(repoDir, caminhoRelativoSeguro(arquivo.origem));
    const relDestino = caminhoRelativoSeguro(arquivo.destino);
    const destino = join(worktreeDir, relDestino);
    if (!(await existe(origem))) {
      avisos.push(`arquivo local ausente na cópia do usuário: ${arquivo.origem}`);
      continue;
    }
    const atual = await lstat(destino).catch(() => null);
    if (atual?.isSymbolicLink()) await rm(destino, { force: true });
    await mkdir(dirname(destino), { recursive: true });
    await cp(origem, destino, {
      recursive: true,
      dereference: true,
      force: true,
      errorOnExist: false,
    });
    copiados.push(relDestino);
  }
  return { copiados, avisos };
}

async function existe(caminho: string): Promise<boolean> {
  return stat(caminho).then(
    () => true,
    () => false,
  );
}

/** `worktree add --detach <dir> <sha>` (integração 03 §8.1 e `evidenciar antes` tardio 03 §5.4). */
export async function criarWorktreeDestacada(
  repoDir: string,
  dir: string,
  sha: string,
  dirDados: string,
): Promise<string> {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  // Sobra de uma integração interrompida (crash): recomeça do zero (03 §9.5).
  if (await existe(dir)) await removerWorktree(repoDir, dir, { dirDados });
  await git(['worktree', 'add', '--detach', dir, sha], { cwd: repoDir });
  return dir;
}

export interface WorktreeListada {
  caminho: string;
  head: string | null;
  /** `refs/heads/...` ou null (destacada). */
  branch: string | null;
  destacada: boolean;
  travada: boolean;
  motivoTrava: string | null;
  prunable: boolean;
  /** A primeira entrada é a cópia do usuário (worktree principal). */
  principal: boolean;
}

/** Interpreta `git worktree list --porcelain` (01 §9.1, linha "Boot"). */
export function interpretarListaWorktrees(saida: string): WorktreeListada[] {
  const lista: WorktreeListada[] = [];
  for (const bloco of saida.split(/\n\n+/)) {
    const linhas = bloco.split('\n').filter(Boolean);
    const primeira = linhas[0];
    if (!primeira?.startsWith('worktree ')) continue;
    const w: WorktreeListada = {
      caminho: primeira.slice('worktree '.length),
      head: null,
      branch: null,
      destacada: false,
      travada: false,
      motivoTrava: null,
      prunable: false,
      principal: lista.length === 0,
    };
    for (const l of linhas.slice(1)) {
      if (l.startsWith('HEAD ')) w.head = l.slice(5);
      else if (l.startsWith('branch ')) w.branch = l.slice(7);
      else if (l === 'detached') w.destacada = true;
      else if (l === 'locked' || l.startsWith('locked ')) {
        w.travada = true;
        w.motivoTrava = l.length > 7 ? l.slice(7) : null;
      } else if (l === 'prunable' || l.startsWith('prunable ')) w.prunable = true;
    }
    lista.push(w);
  }
  return lista;
}

export async function listarWorktrees(repoDir: string): Promise<WorktreeListada[]> {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd: repoDir });
  return interpretarListaWorktrees(r.stdout);
}

/** Execução dona da worktree, lida do motivo da trava `forja:<execucao_id>`. */
export function execucaoDaTrava(w: WorktreeListada): string | null {
  const m = /^forja:(.+)$/.exec(w.motivoTrava ?? '');
  return m?.[1] ?? null;
}

export interface WorktreeOrfa {
  worktree: WorktreeListada;
  /** Execução registrada na trava (pode existir no SQLite, mas não ativa). */
  execucaoId: string | null;
}

/**
 * Órfãs (01 §9.1, "Boot"): worktrees da Forja (sob `<dados>/worktrees/`) sem
 * execução ativa no SQLite. `caminhosAtivos` = `execucao.worktree_dir` das
 * execuções não terminais (e as `worktree_integracao_dir` em uso). Prunable fica
 * de fora: é podada, não oferecida.
 */
export function detectarOrfas(
  lista: readonly WorktreeListada[],
  dirDados: string,
  caminhosAtivos: ReadonlySet<string>,
): WorktreeOrfa[] {
  const raiz = join(dirDados, 'worktrees');
  const ativos = new Set([...caminhosAtivos].map((c) => resolve(c)));
  return lista
    .filter((w) => !w.principal && !w.prunable && dentroDe(raiz, w.caminho))
    .filter((w) => !ativos.has(resolve(w.caminho)))
    .map((w) => ({ worktree: w, execucaoId: execucaoDaTrava(w) }));
}

export interface OpcoesRemover {
  /** Raiz do diretório de dados: remoção fora de `<dados>/worktrees/` é recusada. */
  dirDados: string;
  /** Apaga a branch local depois (descartada). Mergeada: só depois do push confirmado. */
  apagarBranch?: string | null;
}

/** `worktree unlock` + `remove --force` + `prune` (+ branch opcional) (01 §9.1, "Limpar"). */
export async function removerWorktree(
  repoDir: string,
  dir: string,
  opcoes: OpcoesRemover,
): Promise<void> {
  const raiz = join(opcoes.dirDados, 'worktrees');
  if (!dentroDe(raiz, dir)) {
    throw new Error(`recusado: ${dir} não é worktree da Forja`);
  }
  if (resolve(dir) === resolve(repoDir)) throw new Error('recusado: cópia do usuário');
  await git(['worktree', 'unlock', dir], { cwd: repoDir, aceitar: [0, 128] });
  await git(['worktree', 'remove', '--force', '--force', dir], {
    cwd: repoDir,
    aceitar: [0, 128],
  });
  await rm(dir, { recursive: true, force: true });
  await podarWorktrees(repoDir);
  if (opcoes.apagarBranch) {
    await git(['branch', '-D', opcoes.apagarBranch], { cwd: repoDir, aceitar: [0, 1] });
  }
}

/** `git worktree prune` (metadados de worktrees cujo diretório sumiu). */
export async function podarWorktrees(repoDir: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoDir });
}
