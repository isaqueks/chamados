import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';
import type { ConfigRepo } from './repo';

/**
 * Testes de INTEGRAÇÃO do sync de repositório com git REAL (origem local,
 * D-011): prova que a working copy analisada pela IA vem da BRANCH CONFIGURADA
 * (`git_branch_padrao`), não da default do remoto — bug corrigido em 2026-07-16
 * (o clone sem `--branch` caía na default; a base do PR já era a configurada).
 *
 * O cache usa `IA_REPO_CACHE_DIR` — setado ANTES do import dinâmico de ./repo
 * (ferramentasConfig congela env no import).
 */

let base: string;
let origem: string;
let repoMod: typeof import('./repo');

beforeAll(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'chamados-branch-'));
  process.env.IA_REPO_CACHE_DIR = join(base, 'cache');
  repoMod = await import('./repo');

  // Origem: branch `main` (default/HEAD) e branch `des` com conteúdo distinto.
  origem = join(base, 'origem');
  await fs.mkdir(origem);
  const g = simpleGit(origem);
  await g.raw(['init', '-b', 'main']);
  await g.addConfig('user.email', 'teste@chamados.dev');
  await g.addConfig('user.name', 'Teste');
  await fs.writeFile(join(origem, 'app.txt'), 'conteudo da MAIN\n');
  await g.add('.');
  await g.commit('commit na main');
  await g.checkoutLocalBranch('des');
  await fs.writeFile(join(origem, 'app.txt'), 'conteudo da DES\n');
  await g.add('.');
  await g.commit('commit na des');
  // HEAD da origem volta para `main` — a DEFAULT do "remoto" é main.
  await g.checkout('main');
}, 30_000);

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function cfg(branch: string): ConfigRepo {
  return {
    tenantId: 'tenant-teste',
    sistemaAlvoId: 'sistema-teste',
    repoUrl: origem,
    branchPadrao: branch,
    credencial: null,
  };
}

describe('sincronizarRepo — branch configurada (fix 2026-07-16)', () => {
  it('clona a branch CONFIGURADA, não a default do remoto', async () => {
    const dir = await repoMod.sincronizarRepo(cfg('des'));
    const conteudo = await fs.readFile(join(dir, 'app.txt'), 'utf8');
    expect(conteudo).toContain('DES');
  });

  it('admin trocou a branch na config → cache re-clona na branch nova', async () => {
    const dir = await repoMod.sincronizarRepo(cfg('main'));
    const conteudo = await fs.readFile(join(dir, 'app.txt'), 'utf8');
    expect(conteudo).toContain('MAIN');
  });

  it('mesma branch → sync reaproveita o cache (pull, sem re-clonar)', async () => {
    const dir = await repoMod.sincronizarRepo(cfg('main'));
    const marcador = join(dir, 'marcador-cache.txt');
    await fs.writeFile(marcador, 'sobrevive ao pull');
    await repoMod.sincronizarRepo(cfg('main'));
    // Arquivo untracked sobrevive a um pull; um re-clone o teria apagado.
    await expect(fs.readFile(marcador, 'utf8')).resolves.toContain('sobrevive');
  });

  it('branch inexistente falha ALTO (git_sync_falhou), nunca cai na default', async () => {
    await expect(repoMod.sincronizarRepo(cfg('nao-existe'))).rejects.toThrow('git_sync_falhou');
  });
});
