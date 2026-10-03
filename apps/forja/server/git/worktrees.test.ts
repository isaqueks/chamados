import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from './apoio-testes';
import {
  caminhoRelativoSeguro,
  caminhoWorktreeBase,
  caminhoWorktreeExecucao,
  criarWorktreeDestacada,
  criarWorktreeExecucao,
  detectarOrfas,
  interpretarListaWorktrees,
  listarWorktrees,
  nomeBranchExecucao,
  removerWorktree,
} from './worktrees';

const EXEC = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

describe('nomes e caminhos', () => {
  it('branch forja/chamado-<n>-<slug>', () => {
    expect(nomeBranchExecucao('forja/', 42, 'Botão Salvar não funciona!')).toBe(
      'forja/chamado-42-botao-salvar-nao-funciona',
    );
  });

  it('worktree em <dados>/worktrees/<slug>/<n>-<exec8>', () => {
    expect(caminhoWorktreeExecucao('/d', 'acme', 7, EXEC)).toBe('/d/worktrees/acme/7-0f1e2d3c');
    expect(caminhoWorktreeBase('/d', 'acme', EXEC)).toBe(
      '/d/worktrees/acme/_integracao/base-0f1e2d3c',
    );
  });

  it('recusa caminho absoluto ou com ..', () => {
    expect(() => caminhoRelativoSeguro('/etc/passwd')).toThrow();
    expect(() => caminhoRelativoSeguro('../fora')).toThrow();
    expect(caminhoRelativoSeguro('config/.env')).toBe('config/.env');
  });
});

describe('interpretarListaWorktrees / detectarOrfas', () => {
  const saida = [
    'worktree /home/u/repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /d/worktrees/acme/7-0f1e2d3c',
    'HEAD bbb',
    'branch refs/heads/forja/chamado-7-x',
    'locked forja:exec-7',
    '',
    'worktree /d/worktrees/acme/8-11111111',
    'HEAD ccc',
    'branch refs/heads/forja/chamado-8-y',
    'locked forja:exec-8',
    '',
    'worktree /d/worktrees/acme/_integracao/abcd1234',
    'HEAD ddd',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  it('lê branch, trava, destacada e prunable', () => {
    const l = interpretarListaWorktrees(saida);
    expect(l).toHaveLength(4);
    expect(l[0]).toMatchObject({ principal: true, branch: 'refs/heads/main' });
    expect(l[1]).toMatchObject({ travada: true, motivoTrava: 'forja:exec-7' });
    expect(l[3]).toMatchObject({ destacada: true, prunable: true });
  });

  it('órfã = sob <dados>/worktrees, sem execução ativa, não prunable', () => {
    const l = interpretarListaWorktrees(saida);
    const orfas = detectarOrfas(l, '/d', new Set(['/d/worktrees/acme/7-0f1e2d3c']));
    expect(orfas.map((o) => o.worktree.caminho)).toEqual(['/d/worktrees/acme/8-11111111']);
    expect(orfas[0]?.execucaoId).toBe('exec-8');
  });
});

describe('worktree real', () => {
  let r: RepoTemporario;
  beforeEach(() => {
    r = criarRepoTemporario();
    writeFileSync(join(r.repo, '.env'), 'SEGREDO=dev\n');
    writeFileSync(join(r.raiz, 'alvo-real'), 'conteudo do alvo\n');
    symlinkSync(join(r.raiz, 'alvo-real'), join(r.repo, 'link.env'));
  });
  afterEach(() => r.limpar());

  const entrada = () => ({
    repoDir: r.repo,
    dirDados: r.dados,
    projetoSlug: 'acme',
    execucaoId: EXEC,
    numero: 12,
    titulo: 'Ajustar relatório',
    branchDestino: 'main',
    prefixoBranch: 'forja/',
    arquivosLocais: [
      { origem: '.env', destino: '.env', modo: 'copiar' as const },
      { origem: 'link.env', destino: 'cfg/link.env', modo: 'copiar' as const },
      { origem: 'nao-existe', destino: 'nao-existe', modo: 'copiar' as const },
    ],
  });

  it('cria a partir da branch de destino, trava e copia (nunca symlink)', async () => {
    const shaMain = r.g(['rev-parse', 'main']);
    const w = await criarWorktreeExecucao(entrada());
    expect(w.branch).toBe('forja/chamado-12-ajustar-relatorio');
    expect(w.shaBase).toBe(shaMain);
    expect(w.dir.startsWith(join(r.dados, 'worktrees', 'acme'))).toBe(true);
    expect(r.g(['rev-parse', 'HEAD'], w.dir)).toBe(shaMain);
    expect(lstatSync(join(w.dir, '.env')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(w.dir, 'cfg/link.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(w.dir, 'cfg/link.env'), 'utf8')).toBe('conteudo do alvo\n');
    expect(w.copiados).toEqual(['.env', 'cfg/link.env']);
    expect(w.avisos).toHaveLength(1);
    const lista = await listarWorktrees(r.repo);
    const minha = lista.find((x) => x.branch === `refs/heads/${w.branch}`);
    expect(minha?.motivoTrava).toBe(`forja:${EXEC}`);
  });

  it('branch existente ganha sufixo -r2 (nunca reescreve)', async () => {
    r.g(['branch', 'forja/chamado-12-ajustar-relatorio']);
    const w = await criarWorktreeExecucao(entrada());
    expect(w.branch).toBe('forja/chamado-12-ajustar-relatorio-r2');
  });

  it('remove (unlock + remove + prune) e apaga a branch descartada', async () => {
    const w = await criarWorktreeExecucao(entrada());
    await removerWorktree(r.repo, w.dir, { dirDados: r.dados, apagarBranch: w.branch });
    expect(existsSync(w.dir)).toBe(false);
    expect(r.g(['branch', '--list', w.branch])).toBe('');
    expect((await listarWorktrees(r.repo)).length).toBe(1);
  });

  it('recusa remover fora de <dados>/worktrees', async () => {
    await expect(removerWorktree(r.repo, r.repo, { dirDados: r.dados })).rejects.toThrow(
      /recusado/,
    );
  });

  it('worktree destacada em sha_base', async () => {
    const base = r.g(['rev-parse', 'HEAD']);
    r.escrever('src/app.ts', 'mudou\n');
    r.commitar('depois');
    const dir = caminhoWorktreeBase(r.dados, 'acme', EXEC);
    await criarWorktreeDestacada(r.repo, dir, base, r.dados);
    expect(r.g(['rev-parse', 'HEAD'], dir)).toBe(base);
    const l = await listarWorktrees(r.repo);
    expect(l.find((x) => x.caminho === dir)?.destacada).toBe(true);
  });
});
