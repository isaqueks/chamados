import { describe, expect, it } from 'vitest';
import {
  abrirPty,
  ambientePty,
  argsAssumir,
  ErroArgsPty,
  limitarDimensao,
  validarArgsSemBypass,
  type FimPty,
} from './pty';

const SESSION = '3f2a9c1e-0b7d-4e2a-9f10-5c6d7e8f9a0b';

describe('PTY (01 §11, 05 §7.2)', () => {
  it('node-pty real: `sh -c "echo ok"` produz ok e sai com 0', async () => {
    const pty = abrirPty({
      comando: 'sh',
      args: ['-c', 'echo ok'],
      cwd: process.cwd(),
      env: ambientePty({ assumida: false }),
    });
    let saida = '';
    pty.aoDados((d) => (saida += d));
    const fim = await new Promise<FimPty>((r) => pty.aoSair(r));
    expect(saida).toContain('ok');
    expect(fim.codigo).toBe(0);
    expect(pty.pid).toBeGreaterThan(1);
  });

  it('node-pty real: entrada, redimensionar e sinal no grupo', async () => {
    const pty = abrirPty({
      comando: 'sh',
      args: [],
      cwd: process.cwd(),
      env: ambientePty({ assumida: false }),
      colunas: 80,
      linhas: 24,
    });
    let saida = '';
    pty.aoDados((d) => (saida += d));
    const saiu = new Promise<FimPty>((r) => pty.aoSair(r));
    pty.redimensionar(100, 30);
    pty.escrever('stty size; echo "fim-$((1+1))"\r');
    const limite = Date.now() + 3000;
    while (!saida.includes('fim-2') && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(saida).toContain('30 100');
    pty.sinalizar('SIGHUP');
    const fim = await saiu;
    expect(fim.codigo !== 0 || fim.sinal !== null).toBe(true);
  });

  it('Assumir: argv exato, sem bypass', () => {
    expect(
      argsAssumir({ session_id: SESSION, settings: '/d/settings.3.json', modelo: 'claude-x' }),
    ).toEqual([
      '--resume',
      SESSION,
      '--setting-sources',
      '',
      '--settings',
      '/d/settings.3.json',
      '--strict-mcp-config',
      '--permission-mode',
      'default',
      '--model',
      'claude-x',
    ]);
    expect(() => argsAssumir({ session_id: 'nao-uuid', settings: '/s', modelo: 'm' })).toThrow(
      ErroArgsPty,
    );
    expect(() => argsAssumir({ session_id: SESSION, settings: 'rel.json', modelo: 'm' })).toThrow();
  });

  it('recusa qualquer forma de bypass no PTY', () => {
    expect(() => validarArgsSemBypass(['--dangerously-skip-permissions'])).toThrow(ErroArgsPty);
    expect(() => validarArgsSemBypass(['--permission-mode', 'bypassPermissions'])).toThrow();
    expect(() => validarArgsSemBypass(['--permission-mode=bypassPermissions'])).toThrow();
    expect(() =>
      abrirPty({ comando: 'sh', args: ['--dangerously-skip-permissions'], cwd: '/', env: {} }),
    ).toThrow(ErroArgsPty);
    expect(() => validarArgsSemBypass(['--permission-mode', 'default'])).not.toThrow();
  });

  it('env: allowlist + TERM; CLAUDE.md desligado só na assumida', () => {
    const origem = { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', CLAUDECODE: '1', TERM: 'dumb' };
    const livre = ambientePty({ assumida: false, origem });
    expect(livre).toMatchObject({ PATH: '/bin', HOME: '/h', TERM: 'xterm-256color' });
    expect(livre.GH_TOKEN).toBeUndefined();
    expect(livre.CLAUDECODE).toBeUndefined();
    expect(livre.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
    expect(ambientePty({ assumida: true, origem }).CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
  });

  it('limita dimensões vindas do navegador', () => {
    expect(limitarDimensao(0, 500, 32)).toBe(1);
    expect(limitarDimensao(99999, 500, 32)).toBe(500);
    expect(limitarDimensao(Number.NaN, 500, 32)).toBe(32);
    expect(limitarDimensao(80.7, 500, 32)).toBe(80);
  });
});
