import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstrategiaIntegracao, ModoEntrega } from '../../comum/estados';
import { commitCheckpoint, type OpcoesCheckpoint } from './checkpoint';
import { ErroGit, ehAncestral, git, redigirCredenciais, resolverSha, statusPorcelain } from './git';
import { criarWorktreeDestacada, listarWorktrees, removerWorktree } from './worktrees';

/**
 * Primitivas git da fila de merge (specs/forja/03 §8, §9.5, §2.5; 05 §9).
 *
 * A ORDEM dos passos (gravar intenção no SQLite antes de agir, voltar ao passo
 * 1, contar recusas, G2') é do orquestrador (`server/dominio`). Aqui ficam só
 * operações git com resultado tipado — nenhuma decide estado.
 *
 * Invariantes que estas funções garantem por construção (03 §8.1):
 * - nunca `--force`/`--force-with-lease`, nunca `stash`/`reset`/`checkout` na
 *   cópia do usuário;
 * - nunca `update-ref` numa branch em checkout (deixa alterações fantasma na
 *   cópia [V 04 §4.4]): em checkout, só `merge --ff-only` com a árvore limpa;
 * - avanço de ref local só por compare-and-swap (`update-ref <ref> <novo> <antigo>`):
 *   se a ref andou durante a integração, a troca é recusada e o item recomeça;
 * - integração sempre numa worktree DESTACADA em `T0`, que funciona mesmo com o
 *   destino em checkout na cópia do usuário.
 *
 * `patch-id`: `git diff -U0 <base>..<sha> | git patch-id --stable` — insensível
 * a número de linha e a contexto, então mudança só de contexto no destino não
 * força G2' (03 §2.5) [NV S9; plano B: diff com contexto padrão e G2' mais
 * frequente].
 *
 * Push: sempre `git push <alvo> <sha>:refs/heads/<destino>` (sem force). O
 * remoto é conferido com `git remote get-url` antes (defesa contra `remote
 * set-url` feito por script, 05 §9). Com credencial HTTPS, ela vai SÓ na URL do
 * argv do push (nunca em config, env ou log), com `credential.helper` vazio para
 * nenhum helper gravá-la; saídas e erros passam por `redigirCredenciais`.
 */

// ---------------------------------------------------------------------------
// Pré-checagem de conflito (03 §8.3)
// ---------------------------------------------------------------------------

export interface PreChecagem {
  conflito: boolean;
  arquivos: string[];
  /** Árvore resultante (só sem conflito). */
  arvore: string | null;
}

/** `git merge-tree --write-tree --name-only <destino> <branch>` (exit 1 = conflito [V 04 §4.2]). */
export async function preChecarConflito(
  repoDir: string,
  destino: string,
  branch: string,
): Promise<PreChecagem> {
  const r = await git(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', destino, branch],
    {
      cwd: repoDir,
      aceitar: [0, 1],
    },
  );
  const linhas = r.stdout.split('\n').filter(Boolean);
  if (r.codigo === 0) return { conflito: false, arquivos: [], arvore: linhas[0] ?? null };
  return { conflito: true, arquivos: [...new Set(linhas.slice(1))], arvore: null };
}

// ---------------------------------------------------------------------------
// patch-id (03 §2.5, §8.1 passo 4)
// ---------------------------------------------------------------------------

/** `patch-id --stable` de `git diff -U0 <base>..<sha>`; `null` se o diff é vazio. */
export async function calcularPatchId(
  dir: string,
  base: string,
  sha: string,
): Promise<string | null> {
  const diff = await git(
    ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', `${base}..${sha}`],
    { cwd: dir, timeoutMs: 300_000 },
  );
  if (!diff.stdout.trim()) return null;
  const r = await git(['patch-id', '--stable'], { cwd: dir, stdin: diff.stdout });
  return r.stdout.trim().split(/\s+/)[0] || null;
}

/** O integrado é o que o humano aprovou? (diferente → G2'). */
export function patchIdConfere(aprovado: string | null, integrado: string | null): boolean {
  return aprovado !== null && aprovado === integrado;
}

// ---------------------------------------------------------------------------
// Base e integração (03 §8.1 passos 1–3)
// ---------------------------------------------------------------------------

export interface CredencialHttps {
  usuario: string;
  token: string;
}

/** `https://host/x.git` → `https://<usuario>:<token>@host/x.git`. Só HTTPS. */
export function urlComCredencial(url: string, cred: CredencialHttps): string {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('credencial na URL só é aceita para remoto https');
  u.username = cred.usuario;
  u.password = cred.token;
  return u.toString();
}

export interface Remoto {
  /** Nome do remoto no projeto (`origin`). */
  nome: string;
  /**
   * URL gravada no projeto (SQLite). Conferida com `git remote get-url` antes
   * de fetch/push; divergência = bloqueio (05 §9). Ausente = sem conferência.
   */
  urlEsperada?: string;
  credencial?: CredencialHttps;
}

/** URL efetiva do remoto (com `insteadOf` expandido), para fixar no cadastro (05 §9). */
export async function urlDoRemoto(repoDir: string, nome: string): Promise<string | null> {
  const r = await git(['remote', 'get-url', nome], { cwd: repoDir, aceitar: [0, 2, 128] });
  return r.codigo === 0 ? r.stdout.trim() || null : null;
}

export class ErroRemotoDivergente extends Error {
  constructor(readonly nome: string) {
    super(`a URL do remoto "${nome}" difere da configurada no projeto`);
    this.name = 'ErroRemotoDivergente';
  }
}

/** Confere o remoto e devolve o alvo do fetch/push + os segredos a redigir. */
async function alvoRemoto(
  repoDir: string,
  remoto: Remoto,
): Promise<{ alvo: string; segredos: string[]; prefixo: string[] }> {
  const atual = (await git(['remote', 'get-url', remoto.nome], { cwd: repoDir })).stdout.trim();
  if (remoto.urlEsperada !== undefined) {
    // `get-url` já expande `insteadOf`; `--push` pega `pushurl`/`pushInsteadOf`
    // (url forjada para o fetch + pushurl real, ou o contrário).
    const push = (
      await git(['remote', 'get-url', '--push', remoto.nome], { cwd: repoDir })
    ).stdout.trim();
    if (atual !== remoto.urlEsperada || push !== remoto.urlEsperada) {
      throw new ErroRemotoDivergente(remoto.nome);
    }
  }
  if (!remoto.credencial) return { alvo: remoto.nome, segredos: [], prefixo: [] };
  return {
    alvo: urlComCredencial(atual, remoto.credencial),
    segredos: [remoto.credencial.token, encodeURIComponent(remoto.credencial.token)],
    prefixo: ['-c', 'credential.helper='],
  };
}

/**
 * `T0` (03 §8.1 passo 1): `merge_e_push` → fetch do destino e
 * `refs/remotes/<remoto>/<destino>`; `merge_local` → `refs/heads/<destino>`.
 */
export async function resolverBaseIntegracao(e: {
  repoDir: string;
  modo: ModoEntrega;
  destino: string;
  remoto: Remoto | null;
}): Promise<string> {
  if (e.modo === 'merge_local') {
    const sha = await resolverSha(e.repoDir, `refs/heads/${e.destino}`);
    if (!sha) throw new ErroGit('rev-parse', 1, '', `destino inexistente: ${e.destino}`);
    return sha;
  }
  if (!e.remoto) throw new Error(`modo ${e.modo} exige remoto`);
  const { alvo, segredos, prefixo } = await alvoRemoto(e.repoDir, e.remoto);
  const rastreio = `refs/remotes/${e.remoto.nome}/${e.destino}`;
  await git([...prefixo, 'fetch', '--no-tags', alvo, `+refs/heads/${e.destino}:${rastreio}`], {
    cwd: e.repoDir,
    segredos,
    timeoutMs: 300_000,
  });
  const sha = await resolverSha(e.repoDir, rastreio);
  if (!sha) throw new ErroGit('fetch', 1, '', `destino remoto inexistente: ${e.destino}`);
  return sha;
}

/** `Chamado #N: <título>` (03 §8.1 passo 3). */
export function mensagemMerge(numero: number, titulo: string): string {
  return `Chamado #${numero}: ${titulo.trim()}`;
}

export type ResultadoIntegracao =
  { tipo: 'limpo'; sha: string; dir: string } | { tipo: 'conflito'; arquivos: string[] };

async function arquivosEmConflito(dir: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: dir });
  return [...new Set(r.stdout.split('\0').filter(Boolean))];
}

/**
 * Merge de `origem` na árvore de `dir` (`--no-ff` ou `--squash` + commit). Em
 * conflito, aborta (a árvore volta ao estado anterior) e devolve os arquivos.
 */
export async function mergeNaArvore(
  dir: string,
  origem: string,
  mensagem: string,
  estrategia: EstrategiaIntegracao = 'merge_no_ff',
): Promise<ResultadoIntegracao> {
  const args =
    estrategia === 'squash'
      ? ['merge', '--squash', origem]
      : ['merge', '--no-ff', '--no-edit', '-m', mensagem, origem];
  const r = await git(args, { cwd: dir, aceitar: [0, 1] });
  if (r.codigo === 1) {
    const arquivos = await arquivosEmConflito(dir);
    if (estrategia === 'squash') {
      await git(['merge', '--abort'], { cwd: dir, aceitar: [0, 128] });
      // `--squash` não grava MERGE_HEAD: o abort pode não bastar; a árvore é nossa.
      await git(['read-tree', '--reset', '-u', 'HEAD'], { cwd: dir });
    } else {
      await git(['merge', '--abort'], { cwd: dir });
    }
    return { tipo: 'conflito', arquivos };
  }
  if (estrategia === 'squash') {
    await git(['commit', '--no-verify', '--quiet', '-m', mensagem], { cwd: dir, aceitar: [0, 1] });
  }
  const sha = await resolverSha(dir, 'HEAD');
  if (!sha) throw new ErroGit('merge', null, '', 'HEAD ausente após o merge');
  return { tipo: 'limpo', sha, dir };
}

/**
 * Passos 2–3 de 03 §8.1: worktree destacada em `T0` + merge da branch do
 * chamado. Conflito → worktree de integração removida (a do chamado fica
 * preservada). O `setup` do projeto na worktree de integração é do chamador,
 * pelo runner de verificação, antes da reverificação (passo 5).
 */
export async function integrarEmWorktreeDestacada(e: {
  repoDir: string;
  dirDados: string;
  dirIntegracao: string;
  t0: string;
  branch: string;
  mensagem: string;
  estrategia?: EstrategiaIntegracao;
}): Promise<ResultadoIntegracao> {
  await criarWorktreeDestacada(e.repoDir, e.dirIntegracao, e.t0, e.dirDados);
  const r = await mergeNaArvore(e.dirIntegracao, e.branch, e.mensagem, e.estrategia);
  if (r.tipo === 'conflito') {
    await removerWorktree(e.repoDir, e.dirIntegracao, { dirDados: e.dirDados });
  }
  return r;
}

/**
 * Reverificação reprovada pelo revisor (03 §8.1 passo 5; FJ-032): o app faz o
 * merge de `T0` na branch do chamado (limpo, já provado no passo 3) para abrir
 * o T1 com as instruções do veredito.
 */
export function integrarDestinoNaBranch(
  worktreeChamado: string,
  t0: string,
  mensagem: string,
): Promise<ResultadoIntegracao> {
  return mergeNaArvore(worktreeChamado, t0, mensagem, 'merge_no_ff');
}

// ---------------------------------------------------------------------------
// Resolução automática de conflito na worktree do chamado (FJ-036; 03 §8.4)
// ---------------------------------------------------------------------------

/** `MERGE_HEAD` da worktree (merge em curso), ou `null`. */
export function mergeEmCurso(dir: string): Promise<string | null> {
  return resolverSha(dir, 'MERGE_HEAD');
}

export type InicioMergeDestino =
  /** `T0` já é ancestral do HEAD: nada a integrar. */
  | { tipo: 'ja_integrado' }
  /** Merge sem conflito, já commitado pelo app. */
  | { tipo: 'limpo'; sha: string }
  /** Merge em curso com marcadores nos `arquivos` (nada commitado). */
  | { tipo: 'conflito'; arquivos: string[] };

/**
 * `git merge --no-ff --no-commit <T0>` na worktree do chamado (FJ-036): em
 * conflito, o merge FICA em curso com os marcadores para o agente resolver; sem
 * conflito, o app commita na hora. A worktree tem de estar limpa (o chamador
 * commita antes).
 */
export async function iniciarMergeDestino(
  dir: string,
  t0: string,
  mensagem: string,
): Promise<InicioMergeDestino> {
  if (await ehAncestral(dir, t0, 'HEAD').catch(() => false)) return { tipo: 'ja_integrado' };
  const r = await git(['merge', '--no-ff', '--no-commit', t0], { cwd: dir, aceitar: [0, 1] });
  if (r.codigo === 1) {
    const arquivos = await arquivosEmConflito(dir);
    if (arquivos.length === 0) {
      // exit 1 sem arquivo em conflito (ex.: arquivo local não rastreado no caminho).
      await git(['merge', '--abort'], { cwd: dir, aceitar: [0, 128] });
      throw new ErroGit('merge', 1, r.stdout, r.stderr || 'merge do destino falhou sem conflito');
    }
    return { tipo: 'conflito', arquivos };
  }
  await git(['commit', '--no-verify', '--quiet', '--allow-empty', '-m', mensagem], { cwd: dir });
  return { tipo: 'limpo', sha: (await resolverSha(dir, 'HEAD')) as string };
}

/** Desfaz o merge em curso (conflito em migration/schema: a worktree volta ao HEAD). */
export async function abortarMerge(dir: string): Promise<void> {
  await git(['merge', '--abort'], { cwd: dir, aceitar: [0, 128] });
}

const MARCADOR_CONFLITO = /^(<{7}|>{7})( |$)/m;

/**
 * Arquivos que ainda têm marcador de conflito (`<<<<<<< `/`>>>>>>> ` no início
 * da linha). `=======` sozinho não conta (sublinhado de título em Markdown).
 * Arquivo apagado na resolução não tem marcador.
 */
export async function arquivosComMarcadores(
  dir: string,
  arquivos: readonly string[],
): Promise<string[]> {
  const restantes: string[] = [];
  for (const a of arquivos) {
    const texto = await readFile(join(dir, a), 'utf8').catch(() => null);
    if (texto !== null && MARCADOR_CONFLITO.test(texto)) restantes.push(a);
  }
  return restantes;
}

/**
 * Conclui o merge do destino com o commit do app (FJ-036): `add -A` (sem os
 * `arquivos_locais`) + commit de merge, mesmo que a resolução tenha deixado a
 * árvore igual ao HEAD (o `MERGE_HEAD` precisa virar segundo pai, senão a
 * próxima integração conflita de novo). Devolve o sha.
 */
export async function concluirMergeDestino(
  dir: string,
  mensagem: string,
  opcoes: OpcoesCheckpoint = {},
): Promise<string> {
  await commitCheckpoint(dir, mensagem, opcoes);
  if (await mergeEmCurso(dir)) {
    await git(['commit', '--no-verify', '--quiet', '--allow-empty', '-m', mensagem], { cwd: dir });
  }
  return (await resolverSha(dir, 'HEAD')) as string;
}

// ---------------------------------------------------------------------------
// Cópia do usuário e avanço da ref local (03 §8.2)
// ---------------------------------------------------------------------------

export interface EstadoCopiaUsuario {
  /** A branch de destino está em checkout em alguma worktree do usuário? */
  emCheckout: boolean;
  /** Diretório dessa worktree (a cópia do usuário, em geral). */
  dir: string | null;
  /** Alterações em arquivos RASTREADOS (não rastreados não impedem `--ff-only`). */
  suja: boolean;
  head: string | null;
}

export async function estadoCopiaUsuario(
  repoDir: string,
  destino: string,
): Promise<EstadoCopiaUsuario> {
  const ref = `refs/heads/${destino}`;
  const w = (await listarWorktrees(repoDir)).find((x) => x.branch === ref && !x.prunable);
  if (!w) return { emCheckout: false, dir: null, suja: false, head: null };
  const suja = (await statusPorcelain(w.caminho, false)).length > 0;
  return { emCheckout: true, dir: w.caminho, suja, head: w.head };
}

export type AvancoLocal =
  | { resultado: 'avancada'; modo: 'update_ref' | 'ff_copia_limpa' }
  /** A ref andou desde `antigo` (CAS recusado) → o item recomeça do passo 1. */
  | { resultado: 'cas_recusado' }
  /**
   * Não mexeu na ref local. `merge_e_push`: o push já valeu, modo `push_direto`
   * com aviso "sua `<destino>` local está atrás". `merge_local`: item bloqueado.
   */
  | {
      resultado: 'intocada';
      motivo: 'copia_suja' | 'copia_divergente' | 'ref_divergente' | 'ff_falhou';
    };

/**
 * Avança `refs/heads/<destino>` para `novo` (03 §8.2, coluna "Ref local"):
 * - fora de checkout e ancestral de `novo` → `update-ref` CAS;
 * - em checkout limpo com `HEAD` ancestral → `merge --ff-only` na cópia;
 * - em checkout sujo ou divergente → não mexe.
 *
 * `antigo` = valor esperado da ref (CAS). Em `merge_local` é o `T0`; em
 * `merge_e_push` (cortesia local, o remoto já é a verdade) pode ser omitido, e
 * vale o valor lido agora.
 */
export async function avancarRefLocal(e: {
  repoDir: string;
  destino: string;
  novo: string;
  antigo?: string;
}): Promise<AvancoLocal> {
  const ref = `refs/heads/${e.destino}`;
  const copia = await estadoCopiaUsuario(e.repoDir, e.destino);
  if (copia.emCheckout && copia.dir) {
    if (e.antigo !== undefined && copia.head !== e.antigo) return { resultado: 'cas_recusado' };
    if (copia.suja) return { resultado: 'intocada', motivo: 'copia_suja' };
    if (!copia.head || !(await ehAncestral(e.repoDir, copia.head, e.novo))) {
      return { resultado: 'intocada', motivo: 'copia_divergente' };
    }
    const ff = await git(['merge', '--ff-only', '--quiet', e.novo], {
      cwd: copia.dir,
      aceitar: [0, 1, 128],
    });
    return ff.codigo === 0
      ? { resultado: 'avancada', modo: 'ff_copia_limpa' }
      : { resultado: 'intocada', motivo: 'ff_falhou' };
  }
  const atual = await resolverSha(e.repoDir, ref);
  const antigo = e.antigo ?? atual;
  if (!antigo || atual !== antigo) return { resultado: 'cas_recusado' };
  if (!(await ehAncestral(e.repoDir, antigo, e.novo))) {
    return { resultado: 'intocada', motivo: 'ref_divergente' };
  }
  const cas = await atualizarRefCas(e.repoDir, ref, e.novo, antigo);
  return cas ? { resultado: 'avancada', modo: 'update_ref' } : { resultado: 'cas_recusado' };
}

/** `git update-ref <ref> <novo> <antigo>`: `false` se a ref não valia mais `antigo`. */
export async function atualizarRefCas(
  repoDir: string,
  ref: string,
  novo: string,
  antigo: string,
): Promise<boolean> {
  const r = await git(['update-ref', '-m', 'forja: integração', ref, novo, antigo], {
    cwd: repoDir,
    aceitar: [0, 1, 128],
  });
  return r.codigo === 0;
}

// ---------------------------------------------------------------------------
// Push (03 §8.2, coluna "Remoto")
// ---------------------------------------------------------------------------

export type ResultadoPush =
  | { resultado: 'aceito' }
  /** Não-ff (o destino andou): volta ao passo 1; 3 seguidas → `precisa_humano`. */
  | { resultado: 'recusado_nao_ff'; detalhe: string }
  | { resultado: 'erro'; detalhe: string };

/** `git push <remoto> <sha>:refs/heads/<destino>`, nunca forçado. */
export async function pushDestino(e: {
  repoDir: string;
  remoto: Remoto;
  sha: string;
  destino: string;
}): Promise<ResultadoPush> {
  const { alvo, segredos, prefixo } = await alvoRemoto(e.repoDir, e.remoto);
  const r = await git(
    [...prefixo, 'push', '--porcelain', alvo, `${e.sha}:refs/heads/${e.destino}`],
    { cwd: e.repoDir, segredos, aceitar: [0, 1, 128], timeoutMs: 300_000 },
  );
  if (r.codigo === 0) return { resultado: 'aceito' };
  const saida = redigirCredenciais(`${r.stdout}\n${r.stderr}`, segredos).trim();
  const detalhe = saida.split('\n').slice(-4).join(' | ').slice(0, 500);
  if (/\[rejected\]|non-fast-forward|fetch first/.test(saida)) {
    return { resultado: 'recusado_nao_ff', detalhe };
  }
  return { resultado: 'erro', detalhe };
}

// ---------------------------------------------------------------------------
// Reconciliação no boot (03 §9.5)
// ---------------------------------------------------------------------------

/** `sha_merge` já está na ref de destino? Sim → `mergeado`, nunca re-mergeia. */
export function jaIntegrado(repoDir: string, shaMerge: string, ref: string): Promise<boolean> {
  return ehAncestral(repoDir, shaMerge, ref);
}

/**
 * O destino andou desde a aprovação E mexeu em arquivos do patch? (FJ-032 §5).
 * `andou` = `t0` não é ancestral do sha aprovado; `arquivos` = os que mudaram
 * dos dois lados desde o `merge-base` (onde uma quebra pela integração é
 * provável). Sem interseção, a Forja integra direto, sem reverificação.
 */
export async function intersecaoComDestino(
  repoDir: string,
  t0: string,
  shaAprovado: string,
): Promise<{ andou: boolean; base: string | null; arquivos: string[] }> {
  if (await ehAncestral(repoDir, t0, shaAprovado))
    return { andou: false, base: null, arquivos: [] };
  const mb = await git(['merge-base', t0, shaAprovado], { cwd: repoDir, aceitar: [0, 1] });
  const base = mb.stdout.trim() || null;
  const nomes = async (a: string, b: string) =>
    (await git(['diff', '--name-only', `${a}..${b}`], { cwd: repoDir })).stdout
      .split('\n')
      .filter(Boolean);
  if (!base) return { andou: true, base: null, arquivos: await nomes(t0, shaAprovado) };
  const doDestino = new Set(await nomes(base, t0));
  const doPatch = await nomes(base, shaAprovado);
  return { andou: true, base, arquivos: doPatch.filter((f) => doDestino.has(f)) };
}
