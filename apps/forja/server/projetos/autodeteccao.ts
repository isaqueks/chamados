import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DETECTORES_CONVENCAO,
  nomeDaPasta,
  type ProjetoDetectado,
} from '../../comum/config-projeto';
import type { SistemaCasadoDto } from '../../comum/dto';
import { git } from '../git/git';

/**
 * Autodetecção do projeto (specs/forja/02 §4.2; FJ-030 §1): o que antes o
 * humano preenchia em seis seções da tela agora é LIDO do repositório.
 *
 * - branch de destino: `origin/HEAD` → `main` → `master` → branch atual;
 * - remoto: `origin` (ou o único que houver); sem remoto = entrega local;
 * - gerenciador pelo lockfile (`package-lock` → `npm ci`, `pnpm-lock` →
 *   `pnpm i --frozen-lockfile`, `yarn.lock` → `yarn --frozen-lockfile`,
 *   `bun.lockb` → `bun i`) — é o `setup` da worktree;
 * - comandos de verificação pelos `scripts` do `package.json` (typecheck,
 *   testes, lint, build, e2e), sempre na raiz (workspaces npm/pnpm rodam lá);
 * - `.env` na raiz e fora do git → copiado para a worktree (`arquivos_locais`);
 * - detectores de selo por convenção (`DETECTORES_CONVENCAO`).
 *
 * POR QUE nunca falha por "não achei": cada lacuna vira `avisos` e o projeto
 * funciona com o que houver (sem comandos = verificação vazia, o nível fica
 * `verificacao_estatica`). Só um diretório que não é repositório git é erro
 * (`ErroRepositorio`): sem git não há worktree.
 */

export class ErroRepositorio extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroRepositorio';
  }
}

/**
 * Grupos de scripts (o primeiro nome existente de cada grupo vence). Só os que
 * EXISTEM no `package.json` viram dica ao agente (FJ-032: a Forja não os executa).
 */
const GRUPOS_SCRIPTS: readonly {
  nome: string;
  scripts: readonly string[];
  timeout_s: number;
}[] = [
  { nome: 'typecheck', scripts: ['typecheck', 'tsc', 'check-types'], timeout_s: 600 },
  { nome: 'lint', scripts: ['lint'], timeout_s: 600 },
  { nome: 'testes', scripts: ['test', 'test:unit'], timeout_s: 1800 },
  { nome: 'build', scripts: ['build'], timeout_s: 1800 },
];
const SCRIPTS_E2E = ['e2e', 'test:e2e'] as const;
const TIMEOUT_SETUP_S = 900;
const TIMEOUT_E2E_S = 1800;

type Gerenciador = NonNullable<ProjetoDetectado['gerenciador']>;

/** Lockfiles na ordem de preferência e o comando de instalação reprodutível de cada um. */
const LOCKFILES: readonly { arquivo: string; gerenciador: Gerenciador; instalar: string }[] = [
  { arquivo: 'package-lock.json', gerenciador: 'npm', instalar: 'npm ci' },
  { arquivo: 'pnpm-lock.yaml', gerenciador: 'pnpm', instalar: 'pnpm i --frozen-lockfile' },
  { arquivo: 'yarn.lock', gerenciador: 'yarn', instalar: 'yarn --frozen-lockfile' },
  { arquivo: 'bun.lockb', gerenciador: 'bun', instalar: 'bun i' },
  { arquivo: 'bun.lock', gerenciador: 'bun', instalar: 'bun i' },
];

/** `npm run x` / `pnpm run x` / `yarn x` / `bun run x`. */
export function comandoDoScript(gerenciador: Gerenciador, script: string): string {
  return gerenciador === 'yarn' ? `yarn ${script}` : `${gerenciador} run ${script}`;
}

/** O placeholder do `npm init` não é teste: rodá-lo deixaria toda verificação vermelha. */
function scriptUtil(corpo: unknown): corpo is string {
  return typeof corpo === 'string' && corpo.trim().length > 0 && !/no test specified/i.test(corpo);
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  workspaces?: unknown;
}

async function lerPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const bruto = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as unknown;
    return bruto && typeof bruto === 'object' ? (bruto as PackageJson) : null;
  } catch {
    return null;
  }
}

async function gitTexto(args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await git(args, { cwd, aceitar: [0, 1, 128] });
    return r.codigo === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** `git rev-parse --show-toplevel` (o diretório tem de existir e ser repositório). */
export async function raizDoRepositorio(dir: string): Promise<string> {
  const info = await stat(dir).catch(() => null);
  if (!info) throw new ErroRepositorio(`a pasta ${dir} não existe`);
  if (!info.isDirectory()) throw new ErroRepositorio(`${dir} não é uma pasta`);
  const raiz = await gitTexto(['rev-parse', '--show-toplevel'], dir);
  if (!raiz) throw new ErroRepositorio(`${dir} não é um repositório git (git rev-parse falhou)`);
  return raiz;
}

async function existeRef(dir: string, ref: string): Promise<boolean> {
  return (await gitTexto(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir)) !== null;
}

/** origin/HEAD → main → master → branch atual (FJ-030 §1). */
export async function detectarBranch(
  dir: string,
  remoto: string | null,
): Promise<{ branch: string | null; origem: ProjetoDetectado['origem_branch'] }> {
  if (remoto) {
    const ref = await gitTexto(['symbolic-ref', '--quiet', `refs/remotes/${remoto}/HEAD`], dir);
    const prefixo = `refs/remotes/${remoto}/`;
    if (ref?.startsWith(prefixo))
      return { branch: ref.slice(prefixo.length), origem: 'origin_head' };
  }
  for (const b of ['main', 'master'] as const) {
    if (await existeRef(dir, `refs/heads/${b}`)) return { branch: b, origem: b };
  }
  const atual = await gitTexto(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  return atual ? { branch: atual, origem: 'atual' } : { branch: null, origem: null };
}

async function detectarRemoto(dir: string): Promise<string | null> {
  const lista = (await gitTexto(['remote'], dir))?.split('\n').filter(Boolean) ?? [];
  if (lista.includes('origin')) return 'origin';
  return lista[0] ?? null;
}

/**
 * Lê o repositório e devolve o que a Forja consegue inferir. `repoDir` pode
 * ser qualquer pasta dentro do repositório: o resultado usa a raiz.
 */
export async function autodetectarProjeto(
  repoDir: string,
  opcoes: { agora?: () => Date } = {},
): Promise<ProjetoDetectado> {
  const dir = await raizDoRepositorio(repoDir);
  const avisos: string[] = [];
  const remoto = await detectarRemoto(dir);
  if (!remoto) avisos.push('sem remoto git: a entrega será merge local (sem push)');
  const { branch, origem } = await detectarBranch(dir, remoto);
  if (!branch) avisos.push('não foi possível descobrir a branch de destino (defina-a no projeto)');

  const lock = LOCKFILES.find((l) => existsSync(join(dir, l.arquivo))) ?? null;
  const pkg = await lerPackageJson(dir);
  let gerenciador: Gerenciador | null = lock?.gerenciador ?? null;
  let setup: ProjetoDetectado['comandos']['setup'] = lock
    ? { comando: lock.instalar, timeout_s: TIMEOUT_SETUP_S }
    : null;
  if (pkg && !lock) {
    gerenciador = 'npm';
    setup = { comando: 'npm install', timeout_s: TIMEOUT_SETUP_S };
    avisos.push('package.json sem lockfile: a instalação usa `npm install` (não reprodutível)');
  }
  if (!pkg) avisos.push('sem package.json na raiz: nenhum comando de verificação detectado');

  const scripts = pkg?.scripts ?? {};
  const verificacao: ProjetoDetectado['comandos']['verificacao'] = [];
  let e2e: ProjetoDetectado['comandos']['e2e'] = null;
  if (pkg && gerenciador) {
    for (const g of GRUPOS_SCRIPTS) {
      const s = g.scripts.find((nome) => scriptUtil(scripts[nome]));
      if (s) {
        verificacao.push({
          nome: g.nome,
          comando: comandoDoScript(gerenciador, s),
          timeout_s: g.timeout_s,
        });
      }
    }
    const s = SCRIPTS_E2E.find((nome) => scriptUtil(scripts[nome]));
    if (s) e2e = { comando: comandoDoScript(gerenciador, s), timeout_s: TIMEOUT_E2E_S };
    if (verificacao.length === 0) {
      avisos.push('nenhum script de typecheck/lint/test/build no package.json');
    }
  }
  const workspaces =
    (pkg !== null && pkg.workspaces !== undefined) || existsSync(join(dir, 'pnpm-workspace.yaml'));

  // Todo `.env*` IGNORADO pelo git, em qualquer pasta (fora de node_modules/build):
  // o caso real (2026-10-03) tinha `.env` em `api-backend/` e `front-end/`, e sem
  // eles o agente não sobe a app nem aplica migration na worktree.
  const arquivos_locais: ProjetoDetectado['arquivos_locais'] = [];
  for (const rel of await envsIgnorados(dir)) {
    arquivos_locais.push({ origem: rel, destino: rel, modo: 'copiar' });
  }

  return {
    detectado_em: (opcoes.agora?.() ?? new Date()).toISOString(),
    repo_dir: dir,
    branch_destino: branch,
    origem_branch: origem,
    remoto,
    gerenciador,
    lockfile: lock?.arquivo ?? null,
    workspaces,
    comandos: {
      dependencias: 'instalar',
      setup,
      verificacao,
      e2e,
      app_subir: null,
      healthcheck: null,
    },
    detectores: structuredClone(DETECTORES_CONVENCAO),
    arquivos_locais,
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Casamento de sistemas-alvo (FJ-030 §1)
// ---------------------------------------------------------------------------

/** Minúsculas, sem acento, só letras e dígitos: "Portal do Cliente" ≡ "portal-do-cliente". */
export function normalizarNomeSistema(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface SistemaDoChamados {
  id: string | null;
  nome: string;
}

/**
 * Sistemas do Chamados cujo nome normalizado é igual ao nome do projeto ou ao
 * nome da pasta do repositório. Igualdade, não "contém": um casamento errado
 * mandaria chamados de outro sistema para este repositório.
 */
export function casarSistemas(
  sistemasDoChamados: readonly SistemaDoChamados[],
  projeto: { nome: string; repo_dir: string },
): SistemaDoChamados[] {
  const alvos = new Set(
    [projeto.nome, nomeDaPasta(projeto.repo_dir)].map(normalizarNomeSistema).filter(Boolean),
  );
  return sistemasDoChamados.filter((s) => alvos.has(normalizarNomeSistema(s.nome)));
}

/**
 * Lista para os toggles da tela (`SistemaCasadoDto`): todos os sistemas
 * conhecidos, marcando o que está ligado neste projeto, o que o casamento
 * sugere e o que já pertence a outro projeto.
 */
export function montarCasamento(e: {
  sistemas: readonly SistemaDoChamados[];
  projeto: { nome: string; repo_dir: string };
  /** Mapeamentos deste projeto (nomes). */
  ligados: readonly string[];
  /** Nome do sistema → nome do OUTRO projeto que o mapeia. */
  deOutros: ReadonlyMap<string, string>;
}): SistemaCasadoDto[] {
  const sugeridos = new Set(casarSistemas(e.sistemas, e.projeto).map((s) => s.nome));
  const porNome = new Map<string, SistemaDoChamados>();
  for (const s of e.sistemas) porNome.set(s.nome, s);
  for (const nome of e.ligados) if (!porNome.has(nome)) porNome.set(nome, { id: null, nome });
  return [...porNome.values()]
    .map((s) => ({
      sistema_nome: s.nome,
      sistema_alvo_id: s.id,
      ligado: e.ligados.includes(s.nome),
      sugerido: sugeridos.has(s.nome),
      outro_projeto: e.deOutros.get(s.nome) ?? null,
    }))
    .sort((a, b) => a.sistema_nome.localeCompare(b.sistema_nome, 'pt-BR'));
}

/**
 * Sistemas a mapear para o projeto: a lista explícita (`config.sistemas`, por
 * id ou nome) ou, ausente, o casamento automático — nunca um sistema que já é
 * de outro projeto (UNIQUE de `mapeamento_sistema`).
 */
export function sistemasDoProjeto(e: {
  explicitos: readonly string[] | undefined;
  sistemas: readonly SistemaDoChamados[];
  projeto: { nome: string; repo_dir: string };
  deOutros: ReadonlyMap<string, string>;
}): { sistema_nome: string; sistema_alvo_id: string | null }[] {
  const escolhidos: SistemaDoChamados[] = e.explicitos
    ? e.explicitos.map(
        (ref) =>
          e.sistemas.find((s) => s.id === ref) ??
          e.sistemas.find((s) => s.nome === ref) ?? { id: null, nome: ref },
      )
    : casarSistemas(e.sistemas, e.projeto);
  const vistos = new Set<string>();
  const saida: { sistema_nome: string; sistema_alvo_id: string | null }[] = [];
  for (const s of escolhidos) {
    if (vistos.has(s.nome) || e.deOutros.has(s.nome)) continue;
    vistos.add(s.nome);
    saida.push({ sistema_nome: s.nome, sistema_alvo_id: s.id });
  }
  return saida;
}

/** Caminhos relativos dos `.env*` que o git ignora (nunca os rastreados). */
export async function envsIgnorados(dir: string): Promise<string[]> {
  try {
    const r = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
      cwd: dir,
      aceitar: [0, 128],
    });
    if (r.codigo !== 0) return [];
    return r.stdout
      .split('\0')
      .filter((p) => /(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/.test(p))
      .filter((p) => !/(^|\/)(node_modules|build|dist|\.next|out|coverage)\//.test(p))
      .sort();
  } catch {
    return existsSync(join(dir, '.env')) ? ['.env'] : [];
  }
}
