import { describe, expect, it } from 'vitest';
import { confinadorBwrap, ehErroDoBwrap, montarComandoBwrap } from './confinamento-bwrap';

const base = {
  worktree: '/h/.local/share/forja/worktrees/acme/1-abc',
  dirGitComum: '/h/dev/acme/.git',
  dirGitWorktree: '/h/dev/acme/.git/worktrees/1-abc',
  home: '/h',
};

function depoisDe(argv: string[], opcao: string, valor: string): boolean {
  return argv.some((a, i) => a === opcao && argv[i + 1] === valor);
}

describe('montarComandoBwrap (05 §5.2) [NV S6]', () => {
  it('home em tmpfs, worktree gravável, .git comum só leitura, comando após --', () => {
    const argv = montarComandoBwrap(['/bin/sh', '-c', 'npm test'], {
      ...base,
      cachesSomenteLeitura: ['/h/.npm'],
    });
    expect(argv[0]).toBe('bwrap');
    expect(depoisDe(argv, '--tmpfs', '/h')).toBe(true);
    expect(depoisDe(argv, '--bind', base.worktree)).toBe(true);
    expect(depoisDe(argv, '--ro-bind', base.dirGitComum)).toBe(true);
    expect(depoisDe(argv, '--bind', base.dirGitWorktree)).toBe(true);
    expect(depoisDe(argv, '--ro-bind-try', '/h/.npm')).toBe(true);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/bin/sh', '-c', 'npm test']);
    // O tmpfs do home vem antes dos binds que moram dentro dele.
    expect(argv.indexOf('/h')).toBeLessThan(argv.indexOf(base.worktree));
    expect(argv).not.toContain('--unshare-net');
  });

  it('rede isolada usa --unshare-net', () => {
    expect(montarComandoBwrap(['true'], { ...base, rede: 'isolada' })).toContain('--unshare-net');
  });

  it('confinador usa o cwd como worktree e reconhece erro do bwrap', () => {
    const c = confinadorBwrap({
      dirGitComum: base.dirGitComum,
      dirGitWorktree: base.dirGitWorktree,
      home: '/h',
    });
    const argv = c.envolver(['true'], { cwd: '/w' });
    expect(depoisDe(argv, '--chdir', '/w')).toBe(true);
    expect(c.ehErroDoConfinador("bwrap: Can't mount proc on /newroot/proc", 1)).toBe(true);
    expect(ehErroDoBwrap('FAIL src/a.test.ts')).toBe(false);
  });
});
