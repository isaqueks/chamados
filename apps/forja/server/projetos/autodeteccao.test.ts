import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from '../git/apoio-testes';
import {
  autodetectarProjeto,
  casarSistemas,
  ErroRepositorio,
  montarCasamento,
  normalizarNomeSistema,
  sistemasDoProjeto,
} from './autodeteccao';

let repos: RepoTemporario[] = [];
const extras: string[] = [];

function novoRepo(): RepoTemporario {
  const r = criarRepoTemporario();
  repos.push(r);
  return r;
}

afterEach(() => {
  for (const r of repos) r.limpar();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
  repos = [];
});

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'app', scripts, ...extra }, null, 2);

describe('autodetectarProjeto (FJ-030 §1)', () => {
  it('npm com lockfile: npm ci + scripts por grupo, na ordem typecheck → lint → testes → build', async () => {
    const r = novoRepo();
    r.escrever(
      'package.json',
      pkg({
        'check-types': 'tsc --noEmit',
        lint: 'eslint .',
        'test:unit': 'vitest run',
        build: 'vite build',
        'test:e2e': 'playwright test',
        dev: 'vite',
      }),
    );
    r.escrever('package-lock.json', '{}');
    r.commitar('pkg');
    const d = await autodetectarProjeto(r.repo, { agora: () => new Date('2026-10-03T12:00:00Z') });
    expect(d.repo_dir).toBe(r.repo);
    expect(d.gerenciador).toBe('npm');
    expect(d.lockfile).toBe('package-lock.json');
    expect(d.comandos.setup).toEqual({ comando: 'npm ci', timeout_s: 900 });
    expect(d.comandos.verificacao).toEqual([
      { nome: 'typecheck', comando: 'npm run check-types', timeout_s: 600 },
      { nome: 'lint', comando: 'npm run lint', timeout_s: 600 },
      { nome: 'testes', comando: 'npm run test:unit', timeout_s: 1800 },
      { nome: 'build', comando: 'npm run build', timeout_s: 1800 },
    ]);
    expect(d.comandos.e2e).toEqual({ comando: 'npm run test:e2e', timeout_s: 1800 });
    expect(d.detectado_em).toBe('2026-10-03T12:00:00.000Z');
    expect(d.detectores.banco).toContain('**/migrations/**');
    expect(d.detectores.frontend).toContain('**/*.{tsx,jsx,vue,svelte,css,scss}');
  });

  it('o primeiro nome do grupo vence; placeholder do npm init não é teste', async () => {
    const r = novoRepo();
    r.escrever(
      'package.json',
      pkg({ typecheck: 'tsc -b', tsc: 'tsc', test: 'echo "Error: no test specified" && exit 1' }),
    );
    r.escrever('package-lock.json', '{}');
    r.commitar('pkg');
    const d = await autodetectarProjeto(r.repo);
    expect(d.comandos.verificacao.map((c) => c.comando)).toEqual(['npm run typecheck']);
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'pnpm i --frozen-lockfile', 'pnpm run lint'],
    ['yarn.lock', 'yarn', 'yarn --frozen-lockfile', 'yarn lint'],
    ['bun.lockb', 'bun', 'bun i', 'bun run lint'],
  ])('lockfile %s → %s', async (lock, gerenciador, instalar, lint) => {
    const r = novoRepo();
    r.escrever('package.json', pkg({ lint: 'eslint .' }));
    r.escrever(lock, 'x');
    r.commitar('pkg');
    const d = await autodetectarProjeto(r.repo);
    expect(d.gerenciador).toBe(gerenciador);
    expect(d.comandos.setup?.comando).toBe(instalar);
    expect(d.comandos.verificacao[0]?.comando).toBe(lint);
  });

  it('package.json sem lockfile: npm install com aviso; sem package.json: sem comandos', async () => {
    const r = novoRepo();
    r.escrever('package.json', pkg({ test: 'vitest run' }));
    r.commitar('pkg');
    const d = await autodetectarProjeto(r.repo);
    expect(d.comandos.setup?.comando).toBe('npm install');
    expect(d.avisos.join(' ')).toMatch(/sem lockfile/);

    const vazio = novoRepo();
    const v = await autodetectarProjeto(vazio.repo);
    expect(v.gerenciador).toBeNull();
    expect(v.comandos.setup).toBeNull();
    expect(v.comandos.verificacao).toEqual([]);
    expect(v.avisos.join(' ')).toMatch(/sem package.json/);
  });

  it('workspaces (npm ou pnpm-workspace.yaml) rodam na raiz', async () => {
    const r = novoRepo();
    r.escrever('package.json', pkg({ test: 'vitest' }, { workspaces: ['apps/*'] }));
    r.escrever('package-lock.json', '{}');
    r.escrever('apps/web/package.json', pkg({ test: 'outra coisa' }));
    r.commitar('ws');
    const d = await autodetectarProjeto(join(r.repo, 'apps', 'web'));
    expect(d.workspaces).toBe(true);
    expect(d.repo_dir).toBe(r.repo);
    expect(d.comandos.verificacao[0]?.comando).toBe('npm run test');

    const p = novoRepo();
    p.escrever('pnpm-workspace.yaml', 'packages: []\n');
    p.commitar('pnpm');
    expect((await autodetectarProjeto(p.repo)).workspaces).toBe(true);
  });

  it('.env na raiz e fora do git vira arquivo local copiado; rastreado, não', async () => {
    const r = novoRepo();
    r.escrever('.gitignore', '.env\n');
    r.commitar('ignore');
    r.escrever('.env', 'SEGREDO=1\n');
    const d = await autodetectarProjeto(r.repo);
    expect(d.arquivos_locais).toEqual([{ origem: '.env', destino: '.env', modo: 'copiar' }]);

    const t = novoRepo();
    t.escrever('.env', 'PUBLICO=1\n');
    t.commitar('env versionado');
    expect((await autodetectarProjeto(t.repo)).arquivos_locais).toEqual([]);
  });

  it('branch: origin/HEAD → main → master → atual; remoto origin', async () => {
    const r = novoRepo();
    let d = await autodetectarProjeto(r.repo);
    expect(d).toMatchObject({ branch_destino: 'main', origem_branch: 'main', remoto: null });
    expect(d.avisos.join(' ')).toMatch(/sem remoto/);

    // Remoto bare com HEAD em `trunk`: origin/HEAD vence a `main` local.
    const bare = mkdtempSync(join(tmpdir(), 'forja-bare-'));
    extras.push(bare);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare]);
    r.g(['remote', 'add', 'origin', bare]);
    r.g(['push', '-q', 'origin', 'main:trunk']);
    r.g(['fetch', '-q', 'origin']);
    r.g(['remote', 'set-head', 'origin', 'trunk']);
    d = await autodetectarProjeto(r.repo);
    expect(d).toMatchObject({
      branch_destino: 'trunk',
      origem_branch: 'origin_head',
      remoto: 'origin',
    });

    const m = novoRepo();
    m.g(['branch', '-m', 'main', 'master']);
    expect((await autodetectarProjeto(m.repo)).branch_destino).toBe('master');

    const a = novoRepo();
    a.g(['branch', '-m', 'main', 'desenvolvimento']);
    d = await autodetectarProjeto(a.repo);
    expect(d).toMatchObject({ branch_destino: 'desenvolvimento', origem_branch: 'atual' });
  });

  it('pasta que não existe ou não é repositório: ErroRepositorio legível', async () => {
    await expect(autodetectarProjeto('/caminho/que/nao/existe')).rejects.toThrow(ErroRepositorio);
    const solto = mkdtempSync(join(tmpdir(), 'forja-solto-'));
    extras.push(solto);
    await expect(autodetectarProjeto(solto)).rejects.toThrow(/não é um repositório git/);
  });
});

describe('casamento de sistemas-alvo (FJ-030 §1)', () => {
  const sistemas = [
    { id: 's1', nome: 'Portal do Cliente' },
    { id: 's2', nome: 'ERP' },
    { id: 's3', nome: 'ERP Legado' },
    { id: null, nome: 'Chamados' },
  ];

  it('normaliza acento, caixa e separadores', () => {
    expect(normalizarNomeSistema('Portal  do Cliente')).toBe('portaldocliente');
    expect(normalizarNomeSistema('portal-do_cliente')).toBe('portaldocliente');
    expect(normalizarNomeSistema('Gestão')).toBe('gestao');
  });

  it('casa por igualdade com o nome do projeto ou a pasta, nunca por "contém"', () => {
    expect(
      casarSistemas(sistemas, { nome: 'qualquer', repo_dir: '/src/portal-do-cliente' }),
    ).toEqual([{ id: 's1', nome: 'Portal do Cliente' }]);
    expect(casarSistemas(sistemas, { nome: 'erp', repo_dir: '/src/x' }).map((s) => s.id)).toEqual([
      's2',
    ]);
    expect(casarSistemas(sistemas, { nome: 'Chamados', repo_dir: '/src/chamados/' })).toHaveLength(
      1,
    );
    expect(casarSistemas(sistemas, { nome: 'Legado', repo_dir: '/src/legado' })).toEqual([]);
  });

  it('explícitos por id ou nome; automático sem a lista; nunca o sistema de outro projeto', () => {
    const projeto = { nome: 'ERP', repo_dir: '/src/erp' };
    expect(
      sistemasDoProjeto({ explicitos: ['s3', 'Chamados'], sistemas, projeto, deOutros: new Map() }),
    ).toEqual([
      { sistema_nome: 'ERP Legado', sistema_alvo_id: 's3' },
      { sistema_nome: 'Chamados', sistema_alvo_id: null },
    ]);
    expect(
      sistemasDoProjeto({ explicitos: undefined, sistemas, projeto, deOutros: new Map() }),
    ).toEqual([{ sistema_nome: 'ERP', sistema_alvo_id: 's2' }]);
    expect(
      sistemasDoProjeto({
        explicitos: undefined,
        sistemas,
        projeto,
        deOutros: new Map([['ERP', 'Outro']]),
      }),
    ).toEqual([]);
  });

  it('montarCasamento marca ligado, sugerido e de outro projeto', () => {
    const lista = montarCasamento({
      sistemas,
      projeto: { nome: 'ERP', repo_dir: '/src/erp' },
      ligados: ['ERP', 'Sistema Antigo'],
      deOutros: new Map([['Chamados', 'Helpdesk']]),
    });
    expect(lista.find((s) => s.sistema_nome === 'ERP')).toMatchObject({
      ligado: true,
      sugerido: true,
      sistema_alvo_id: 's2',
    });
    expect(lista.find((s) => s.sistema_nome === 'Sistema Antigo')).toMatchObject({
      ligado: true,
      sugerido: false,
      sistema_alvo_id: null,
    });
    expect(lista.find((s) => s.sistema_nome === 'Chamados')?.outro_projeto).toBe('Helpdesk');
  });
});
