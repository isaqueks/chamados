import { describe, expect, it } from 'vitest';
import { ErroAmbienteProibido, montarAmbiente } from './ambiente';
import { ErroSessaoOcupada, LocksSessaoMemoria, type DonoLock } from './lock-sessao';

describe('ambiente por allowlist (01 §6.1, 05 §4.7)', () => {
  const origem = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LANG: 'pt_BR.UTF-8',
    LC_TIME: 'pt_BR.UTF-8',
    SHELL: '/bin/zsh',
    TMPDIR: '/tmp',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    GH_TOKEN: 'ghp_x',
    SSH_AUTH_SOCK: '/run/ssh',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    CHAMADOS_TOKEN: 'segredo',
    NODE_OPTIONS: '--inspect',
  };

  it('herda só a allowlist (+ LC_*) e acrescenta as fixas', () => {
    expect(montarAmbiente(origem)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'pt_BR.UTF-8',
      LC_TIME: 'pt_BR.UTF-8',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
  });

  it('extras vencem a base, mas variável proibida é erro', () => {
    expect(montarAmbiente(origem, { extras: { TERM: 'xterm-256color' } }).TERM).toBe(
      'xterm-256color',
    );
    for (const nome of ['GH_TOKEN', 'SSH_AUTH_SOCK', 'CHAMADOS_URL', 'CLAUDE_CODE_IDE_SOCKET']) {
      expect(() => montarAmbiente(origem, { extras: { [nome]: 'x' } })).toThrow(
        ErroAmbienteProibido,
      );
    }
  });

  it('ANTHROPIC_API_KEY só com a opção explícita do usuário (05 §10)', () => {
    expect(() => montarAmbiente(origem, { extras: { ANTHROPIC_API_KEY: 'k' } })).toThrow();
    expect(
      montarAmbiente(origem, { extras: { ANTHROPIC_API_KEY: 'k' }, permitirApiKey: true })
        .ANTHROPIC_API_KEY,
    ).toBe('k');
  });

  it('semFixas omite as variáveis da CLI', () => {
    expect(montarAmbiente(origem, { semFixas: true }).DISABLE_AUTOUPDATER).toBeUndefined();
  });
});

describe('lock por session_id (01 §6.8)', () => {
  const etapa: DonoLock = { tipo: 'etapa', etapa_id: 'e1' };
  const terminal: DonoLock = { tipo: 'terminal', sessao_terminal_id: 't1' };

  it('um dono por sessão; readquirir com o mesmo dono é idempotente', () => {
    const espelho: string[] = [];
    const locks = new LocksSessaoMemoria({
      aoAdquirir: (s, d) => espelho.push(`+${s}:${d.tipo}`),
      aoLiberar: (s, d) => espelho.push(`-${s}:${d.tipo}`),
    });
    locks.adquirir('s1', etapa);
    locks.adquirir('s1', etapa);
    expect(() => locks.adquirir('s1', terminal)).toThrow(ErroSessaoOcupada);
    expect(locks.liberar('s1', terminal)).toBe(false);
    expect(locks.liberar('s1', etapa)).toBe(true);
    locks.adquirir('s1', terminal);
    expect(locks.dono('s1')).toEqual(terminal);
    expect(espelho).toEqual(['+s1:etapa', '-s1:etapa', '+s1:terminal']);
  });

  it('a mensagem diz que a sessão está assumida no Terminal', () => {
    const locks = new LocksSessaoMemoria();
    locks.adquirir('s2', terminal);
    expect(() => locks.adquirir('s2', etapa)).toThrow(/assumida no Terminal/);
  });
});
