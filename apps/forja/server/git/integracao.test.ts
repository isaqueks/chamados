import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, linhas, type RepoTemporario } from './apoio-testes';
import {
  atualizarRefCas,
  avancarRefLocal,
  calcularPatchId,
  ErroRemotoDivergente,
  estadoCopiaUsuario,
  integrarEmWorktreeDestacada,
  jaIntegrado,
  mensagemMerge,
  patchIdConfere,
  preChecarConflito,
  pushDestino,
  resolverBaseIntegracao,
  urlComCredencial,
  urlDoRemoto,
} from './integracao';
import { caminhoWorktreeIntegracao, listarWorktrees } from './worktrees';

const ITEM = 'aa11bb22-0000-0000-0000-000000000000';

describe('puros', () => {
  it('patchIdConfere exige igualdade e não aceita nulo', () => {
    expect(patchIdConfere('abc', 'abc')).toBe(true);
    expect(patchIdConfere('abc', 'abd')).toBe(false);
    expect(patchIdConfere(null, null)).toBe(false);
  });

  it('credencial só em https', () => {
    expect(urlComCredencial('https://h/x.git', { usuario: 'bot', token: 't0k' })).toBe(
      'https://bot:t0k@h/x.git',
    );
    expect(() => urlComCredencial('git@h:x.git', { usuario: 'a', token: 'b' })).toThrow();
  });

  it('mensagem do merge', () => {
    expect(mensagemMerge(42, ' Corrigir total ')).toBe('Chamado #42: Corrigir total');
  });
});

describe('fila de merge com git real', () => {
  let r: RepoTemporario;
  let remoto: string;
  const branch = 'forja/chamado-5-total';

  beforeEach(() => {
    r = criarRepoTemporario();
    remoto = join(r.raiz, 'remoto.git');
    r.g(['init', '-q', '--bare', '-b', 'main', remoto], r.raiz);
    r.g(['remote', 'add', 'origin', remoto]);
    r.g(['push', '-q', 'origin', 'main']);
    // Branch do chamado muda o fim do arquivo; o destino mudará o começo.
    r.g(['checkout', '-q', '-b', branch]);
    r.escrever('src/app.ts', linhas(30, { 28: 'linha 28 corrigida' }));
    r.commitar('forja: passo 1 (#5)');
    r.g(['checkout', '-q', 'main']);
  });
  afterEach(() => r.limpar());

  const integrar = (t0: string) =>
    integrarEmWorktreeDestacada({
      repoDir: r.repo,
      dirDados: r.dados,
      dirIntegracao: caminhoWorktreeIntegracao(r.dados, 'acme', ITEM),
      t0,
      branch,
      mensagem: mensagemMerge(5, 'total'),
    });

  it('merge-tree: limpo sem conflito; conflito lista os arquivos', async () => {
    expect((await preChecarConflito(r.repo, 'main', branch)).conflito).toBe(false);
    r.escrever('src/app.ts', linhas(30, { 28: 'linha 28 do destino' }));
    r.commitar('destino conflitante');
    const p = await preChecarConflito(r.repo, 'main', branch);
    expect(p).toMatchObject({ conflito: true, arquivos: ['src/app.ts'] });
    // Pré-checagem não toca a árvore do usuário.
    expect(r.g(['status', '--porcelain'])).toBe('');
  });

  it('patch-id estável: igual com só contexto mudado no destino, diferente com 1 byte', async () => {
    const base = r.g(['rev-parse', 'main']);
    const aprovado = await calcularPatchId(r.repo, base, branch);
    expect(aprovado).toMatch(/^[0-9a-f]{40}$/);

    // Inserção no topo: desloca a numeração das linhas do hunk do chamado.
    r.escrever('src/app.ts', linhas(30, { 2: 'nova a\nnova b\nnova c' }));
    const t0 = r.commitar('destino andou longe');
    const res = await integrar(t0);
    expect(res.tipo).toBe('limpo');
    if (res.tipo !== 'limpo') return;
    expect(r.g(['log', '-1', '--format=%s %p'], res.dir)).toMatch(/^Chamado #5: total \w+ \w+$/);
    const integrado = await calcularPatchId(res.dir, t0, res.sha);
    expect(patchIdConfere(aprovado, integrado)).toBe(true);

    r.g(['checkout', '-q', branch]);
    r.escrever('src/app.ts', linhas(30, { 28: 'linha 28 corrigidA' }));
    const outro = r.commitar('1 byte');
    r.g(['checkout', '-q', 'main']);
    expect(await calcularPatchId(r.repo, base, outro)).not.toBe(aprovado);
  });

  it('integração destacada com conflito: aborta e remove a worktree de integração', async () => {
    r.escrever('src/app.ts', linhas(30, { 28: 'linha 28 do destino' }));
    const t0 = r.commitar('destino conflitante');
    const res = await integrar(t0);
    expect(res).toEqual({ tipo: 'conflito', arquivos: ['src/app.ts'] });
    expect((await listarWorktrees(r.repo)).length).toBe(1);
  });

  it('CAS recusa a ref que andou durante a integração', async () => {
    const t0 = r.g(['rev-parse', 'main']);
    const res = await integrar(t0);
    if (res.tipo !== 'limpo') throw new Error('esperado limpo');
    // Usuário sai da main (fora de checkout) e alguém avança a main.
    r.g(['checkout', '-q', '--detach']);
    r.g(['update-ref', 'refs/heads/main', branch]);
    expect(await atualizarRefCas(r.repo, 'refs/heads/main', res.sha, t0)).toBe(false);
    expect(
      await avancarRefLocal({ repoDir: r.repo, destino: 'main', novo: res.sha, antigo: t0 }),
    ).toEqual({ resultado: 'cas_recusado' });
  });

  it('fora de checkout: update-ref CAS avança', async () => {
    const t0 = r.g(['rev-parse', 'main']);
    const res = await integrar(t0);
    if (res.tipo !== 'limpo') throw new Error('esperado limpo');
    r.g(['checkout', '-q', '--detach']);
    expect(
      await avancarRefLocal({ repoDir: r.repo, destino: 'main', novo: res.sha, antigo: t0 }),
    ).toEqual({ resultado: 'avancada', modo: 'update_ref' });
    expect(r.g(['rev-parse', 'main'])).toBe(res.sha);
    expect(await jaIntegrado(r.repo, res.sha, 'refs/heads/main')).toBe(true);
  });

  it('em checkout limpo: merge --ff-only na cópia', async () => {
    const t0 = r.g(['rev-parse', 'main']);
    const res = await integrar(t0);
    if (res.tipo !== 'limpo') throw new Error('esperado limpo');
    expect(await avancarRefLocal({ repoDir: r.repo, destino: 'main', novo: res.sha })).toEqual({
      resultado: 'avancada',
      modo: 'ff_copia_limpa',
    });
    expect(readFileSync(join(r.repo, 'src/app.ts'), 'utf8')).toContain('linha 28 corrigida');
  });

  it('cópia do usuário na main e suja: push direto aceito, cópia intacta', async () => {
    const t0 = await resolverBaseIntegracao({
      repoDir: r.repo,
      modo: 'merge_e_push',
      destino: 'main',
      remoto: { nome: 'origin', urlEsperada: remoto },
    });
    const res = await integrar(t0);
    if (res.tipo !== 'limpo') throw new Error('esperado limpo');
    r.escrever('README.md', '# editando localmente\n');
    const antesHead = r.g(['rev-parse', 'HEAD']);

    const copia = await estadoCopiaUsuario(r.repo, 'main');
    expect(copia).toMatchObject({ emCheckout: true, suja: true, dir: r.repo });

    const push = await pushDestino({
      repoDir: r.repo,
      remoto: { nome: 'origin', urlEsperada: remoto },
      sha: res.sha,
      destino: 'main',
    });
    expect(push).toEqual({ resultado: 'aceito' });
    expect(r.g(['rev-parse', 'main'], remoto)).toBe(res.sha);
    expect(await avancarRefLocal({ repoDir: r.repo, destino: 'main', novo: res.sha })).toEqual({
      resultado: 'intocada',
      motivo: 'copia_suja',
    });
    expect(r.g(['rev-parse', 'HEAD'])).toBe(antesHead);
    expect(readFileSync(join(r.repo, 'README.md'), 'utf8')).toBe('# editando localmente\n');
    expect(await jaIntegrado(r.repo, res.sha, 'main')).toBe(false);
  });

  it('push não-ff é recusado (nunca força)', async () => {
    const outro = join(r.raiz, 'outro');
    r.g(['clone', '-q', remoto, outro], r.raiz);
    r.g(
      ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'x'],
      outro,
    );
    r.g(['push', '-q', 'origin', 'main'], outro);
    const t0 = r.g(['rev-parse', 'main']);
    const res = await integrar(t0);
    if (res.tipo !== 'limpo') throw new Error('esperado limpo');
    const push = await pushDestino({
      repoDir: r.repo,
      remoto: { nome: 'origin' },
      sha: res.sha,
      destino: 'main',
    });
    expect(push.resultado).toBe('recusado_nao_ff');
  });

  it('remoto com URL trocada por fora bloqueia o push', async () => {
    await expect(
      pushDestino({
        repoDir: r.repo,
        remoto: { nome: 'origin', urlEsperada: '/outro/lugar.git' },
        sha: r.g(['rev-parse', 'main']),
        destino: 'main',
      }),
    ).rejects.toBeInstanceOf(ErroRemotoDivergente);
  });

  it('pushurl/insteadOf plantados por script: fetch e push bloqueados com a URL fixada', async () => {
    const fixada = (await urlDoRemoto(r.repo, 'origin')) as string;
    expect(fixada).toBe(remoto);
    const alvo = { nome: 'origin', urlEsperada: fixada };
    // url real + pushurl para outro lugar (ou o contrário): divergência.
    r.g(['config', 'remote.origin.pushurl', join(r.raiz, 'atacante.git')]);
    await expect(
      pushDestino({
        repoDir: r.repo,
        remoto: alvo,
        sha: r.g(['rev-parse', 'main']),
        destino: 'main',
      }),
    ).rejects.toBeInstanceOf(ErroRemotoDivergente);
    r.g(['config', '--unset', 'remote.origin.pushurl']);
    // insteadOf reescreve a URL efetiva do fetch.
    r.g(['config', `url.${join(r.raiz, 'atacante.git')}.insteadOf`, remoto]);
    await expect(
      resolverBaseIntegracao({
        repoDir: r.repo,
        modo: 'merge_e_push',
        destino: 'main',
        remoto: alvo,
      }),
    ).rejects.toBeInstanceOf(ErroRemotoDivergente);
  });
});
