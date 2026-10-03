import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from './apoio-testes';
import { ErroGit, envGit, git, redigirCredenciais, REDIGIDO, statusPorcelain } from './git';

describe('redigirCredenciais', () => {
  it('troca o userinfo de URLs e os segredos conhecidos', () => {
    const t = 'fatal: unable to access https://bot:ghp_SEGREDO123@github.com/x/y.git/';
    const r = redigirCredenciais(t, ['ghp_SEGREDO123']);
    expect(r).not.toContain('ghp_SEGREDO123');
    expect(r).not.toContain('bot:');
    expect(r).toContain(`https://${REDIGIDO}@github.com/x/y.git/`);
  });

  it('não mexe em URL sem credencial', () => {
    expect(redigirCredenciais('https://github.com/x/y.git')).toBe('https://github.com/x/y.git');
  });
});

describe('envGit', () => {
  it('é allowlist: sem tokens, com HOME/PATH/SSH_AUTH_SOCK', () => {
    const env = envGit({
      PATH: '/usr/bin',
      HOME: '/home/u',
      SSH_AUTH_SOCK: '/tmp/ssh',
      GH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'y',
      CHAMADOS_TOKEN: 'z',
      CLAUDECODE: '1',
      LC_CTYPE: 'pt_BR.UTF-8',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/tmp/ssh' });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CHAMADOS_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('git (wrapper do app)', () => {
  let r: RepoTemporario;
  beforeEach(() => {
    r = criarRepoTemporario();
  });
  afterEach(() => r.limpar());

  it('neutraliza hooks do repositório (core.hooksPath=/dev/null)', async () => {
    const marca = join(r.raiz, 'hook-rodou');
    const hook = join(r.repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch ${marca}\n`);
    chmodSync(hook, 0o755);
    r.escrever('novo.txt', 'x');
    await git(['add', '-A'], { cwd: r.repo });
    await git(['commit', '-q', '-m', 'com hook'], { cwd: r.repo });
    expect(existsSync(marca)).toBe(false);
  });

  it('erro sem argv e com a credencial redigida', async () => {
    const erro = await git(['fetch', 'https://bot:ghp_X9X9X9@127.0.0.1:1/x.git'], {
      cwd: r.repo,
      segredos: ['ghp_X9X9X9'],
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroGit);
    const e = erro as ErroGit;
    expect(e.subcomando).toBe('fetch');
    expect(e.message).not.toContain('ghp_X9X9X9');
    expect(e.stderr).not.toContain('ghp_X9X9X9');
  });

  it('statusPorcelain distingue rastreados de não rastreados', async () => {
    r.escrever('solto.txt', 'x');
    expect(await statusPorcelain(r.repo)).toHaveLength(1);
    expect(await statusPorcelain(r.repo, false)).toHaveLength(0);
  });
});
