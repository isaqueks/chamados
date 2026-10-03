import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from './apoio-testes';
import { commitCheckpoint, ErroCheckpointBranch, mensagemPasso } from './checkpoint';

describe('commitCheckpoint', () => {
  let r: RepoTemporario;
  beforeEach(() => {
    r = criarRepoTemporario();
  });
  afterEach(() => r.limpar());

  it('não commita árvore limpa (o sha não muda)', async () => {
    const antes = r.g(['rev-parse', 'HEAD']);
    expect(await commitCheckpoint(r.repo, mensagemPasso(1, 9))).toBeNull();
    expect(r.g(['rev-parse', 'HEAD'])).toBe(antes);
  });

  it('commita tudo (inclusive não rastreado) com a mensagem do passo', async () => {
    r.escrever('src/app.ts', 'alterado\n');
    r.escrever('src/novo.ts', 'novo\n');
    const c = await commitCheckpoint(r.repo, mensagemPasso('P2', 9));
    expect(c).not.toBeNull();
    expect(c?.arquivos).toBe(2);
    expect(r.g(['log', '-1', '--format=%s'])).toBe('forja: passo P2 (#9)');
    expect(r.g(['rev-parse', 'HEAD'])).toBe(c?.sha);
    expect(r.g(['status', '--porcelain'])).toBe('');
  });

  it('tenta de novo enquanto o index.lock está preso', async () => {
    r.escrever('src/app.ts', 'alterado\n');
    const lock = join(r.repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    let esperas = 0;
    const c = await commitCheckpoint(r.repo, 'forja: passo 1 (#1)', {
      dormir: async () => {
        esperas++;
        if (esperas === 2) rmSync(lock);
      },
    });
    expect(esperas).toBe(2);
    expect(c).not.toBeNull();
  });

  it('desiste depois das tentativas', async () => {
    r.escrever('src/app.ts', 'alterado\n');
    writeFileSync(join(r.repo, '.git', 'index.lock'), '');
    await expect(
      commitCheckpoint(r.repo, 'x', { tentativas: 3, dormir: async () => undefined }),
    ).rejects.toThrow(/index\.lock|add/);
  });

  it('nunca versiona os arquivos_locais, mesmo não ignorados ou já preparados pelo agente', async () => {
    r.escrever('config.local.json', '{"senha":"s3cr3t0"}\n');
    r.escrever('.env', 'DB_PASSWORD=s3cr3t0\n');
    r.escrever('src/app.ts', 'alterado\n');
    r.g(['add', '.env']);
    const c = await commitCheckpoint(r.repo, mensagemPasso(1, 9), {
      excluir: ['config.local.json', './.env'],
    });
    expect(c).not.toBeNull();
    expect(r.g(['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual(['src/app.ts']);
    // Só os locais mudaram: nada a commitar.
    r.escrever('.env', 'DB_PASSWORD=outra\n');
    expect(
      await commitCheckpoint(r.repo, 'x', { excluir: ['.env', 'config.local.json'] }),
    ).toBeNull();
  });

  it('HEAD fora da branch da execução: recusa sem commitar (git switch do agente)', async () => {
    r.g(['checkout', '-q', '-b', 'forja/12-x']);
    r.g(['checkout', '-q', 'main']);
    r.escrever('src/app.ts', 'alterado\n');
    const antes = r.g(['rev-parse', 'main']);
    await expect(
      commitCheckpoint(r.repo, mensagemPasso(1, 12), { branch: 'forja/12-x' }),
    ).rejects.toBeInstanceOf(ErroCheckpointBranch);
    expect(r.g(['rev-parse', 'main'])).toBe(antes);
    r.g(['checkout', '-q', 'forja/12-x']);
    expect(
      await commitCheckpoint(r.repo, mensagemPasso(1, 12), { branch: 'forja/12-x' }),
    ).not.toBeNull();
  });
});
