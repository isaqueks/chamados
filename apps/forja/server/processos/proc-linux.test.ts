import { describe, expect, it } from 'vitest';
import {
  confereComando,
  dentroDe,
  interpretarCmdline,
  interpretarStat,
  processosNaRaiz,
  sondarProcesso,
  type LeitorProc,
  type StatProc,
} from './proc-linux';

interface ProcFalso {
  argv: string[] | null;
  stat: StatProc | null;
  cwd: string | null;
}

function leitor(procs: Record<number, ProcFalso>): LeitorProc {
  return {
    cmdline: (pid) => procs[pid]?.argv ?? null,
    stat: (pid) => procs[pid]?.stat ?? null,
    cwd: (pid) => procs[pid]?.cwd ?? null,
    pids: () => Object.keys(procs).map(Number),
  };
}

describe('/proc (01 §6.7)', () => {
  it('interpreta stat com comm que tem espaço e parêntese', () => {
    expect(interpretarStat('4242 (meu (proc) x) S 10 4242 4242 0 -1')).toEqual({
      ppid: 10,
      pgid: 4242,
      sid: 4242,
    });
    expect(interpretarStat('lixo')).toBeNull();
  });

  it('interpreta cmdline separado por NUL', () => {
    expect(interpretarCmdline('claude\0-p\0--verbose\0')).toEqual(['claude', '-p', '--verbose']);
  });

  it('confere o comando direto ou via interpretador (shebang)', () => {
    expect(confereComando(['claude', '-p'], 'claude')).toBe(true);
    expect(confereComando(['/home/u/.local/bin/claude'], 'claude')).toBe(true);
    expect(confereComando(['node', '/usr/lib/node_modules/.bin/claude', '-p'], 'claude')).toBe(
      true,
    );
    expect(confereComando(['/bin/sh', '-c', 'npm test'], 'sh')).toBe(true);
    expect(confereComando(['vim', 'claude'], 'claude')).toBe(false);
    expect(confereComando(['node', 'servidor.js'], 'claude')).toBe(false);
  });

  it('dentroDe compara por segmento, não por prefixo cru', () => {
    expect(dentroDe('/d/worktrees/p/1-abc', '/d/worktrees')).toBe(true);
    expect(dentroDe('/d/worktrees', '/d/worktrees/')).toBe(true);
    expect(dentroDe('/d/worktrees-velhas/x', '/d/worktrees')).toBe(false);
  });

  describe('sondarProcesso', () => {
    const vivo = { argv: ['claude', '-p'], stat: { ppid: 1, pgid: 100, sid: 100 }, cwd: '/w' };
    it('nosso: comando e pgid conferem', () => {
      expect(
        sondarProcesso(
          { pid: 100, pgid: 100, comando: 'claude' },
          { leitor: leitor({ 100: vivo }) },
        ),
      ).toBe('vivo');
    });
    it('pid reutilizado por outro programa → não é nosso', () => {
      const outro = { ...vivo, argv: ['firefox'] };
      expect(
        sondarProcesso(
          { pid: 100, pgid: 100, comando: 'claude' },
          { leitor: leitor({ 100: outro }), grupoVivo: () => true },
        ),
      ).toBe('pid_reutilizado');
    });
    it('mesmo comando em outro grupo também não é nosso', () => {
      const outroGrupo = { ...vivo, stat: { ppid: 1, pgid: 555, sid: 555 } };
      expect(
        sondarProcesso(
          { pid: 100, pgid: 100, comando: 'claude' },
          { leitor: leitor({ 100: outroGrupo }) },
        ),
      ).toBe('pid_reutilizado');
    });
    it('líder morto com o grupo ainda respondendo → grupo órfão', () => {
      expect(
        sondarProcesso(
          { pid: 100, pgid: 100, comando: 'claude' },
          { leitor: leitor({}), grupoVivo: (g) => g === 100 },
        ),
      ).toBe('grupo_orfao');
    });
    it('nada responde → morto', () => {
      expect(
        sondarProcesso(
          { pid: 100, pgid: 100, comando: 'claude' },
          { leitor: leitor({}), grupoVivo: () => false },
        ),
      ).toBe('morto');
    });
  });

  it('processosNaRaiz acha cwd dentro da worktree e poupa sessões protegidas', () => {
    const l = leitor({
      200: { argv: ['node'], stat: { ppid: 1, pgid: 200, sid: 200 }, cwd: '/d/wt/1-a' },
      201: { argv: ['vite'], stat: { ppid: 200, pgid: 200, sid: 200 }, cwd: '/d/wt/1-a/web' },
      300: { argv: ['claude'], stat: { ppid: 1, pgid: 300, sid: 300 }, cwd: '/d/wt/1-a' },
      400: { argv: ['bash'], stat: { ppid: 1, pgid: 400, sid: 400 }, cwd: '/home/u' },
      500: { argv: ['x'], stat: { ppid: 1, pgid: 500, sid: 500 }, cwd: null },
    });
    expect(processosNaRaiz('/d/wt/1-a', { leitor: l, sessoesProtegidas: new Set([300]) })).toEqual([
      200, 201,
    ]);
  });
});
