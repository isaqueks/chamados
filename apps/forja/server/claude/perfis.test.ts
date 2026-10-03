import { describe, expect, it } from 'vitest';
import {
  ALLOW_CHECKS_T2,
  atualizarAgentesNegados,
  ErroPerfil,
  montarComando,
  montarComandoAssumir,
  montarEnvBase,
  orcamentoEtapa,
  registroPerfil,
  type EntradaPerfil,
  type NomePerfil,
} from './perfis';

const SID = '11111111-2222-4333-8444-555555555555';

const ENV_APP = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  USER: 'u',
  LANG: 'pt_BR.UTF-8',
  LC_ALL: 'pt_BR.UTF-8',
  TERM: 'xterm',
  SHELL: '/bin/zsh',
  TMPDIR: '/tmp',
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'x',
  CLAUDE_CODE_MESSAGING_TOKEN: 'segredo',
  GH_TOKEN: 'ghp_x',
  GITHUB_TOKEN: 'ghp_y',
  ANTHROPIC_API_KEY: 'sk-ant',
  CHAMADOS_TOKEN: 'tok',
  SSH_AUTH_SOCK: '/run/ssh',
  GPG_AGENT_INFO: 'x',
  AWS_SECRET_ACCESS_KEY: 'aws',
  NODE_OPTIONS: '--inspect',
};

function entrada(perfil: NomePerfil, extra: Partial<EntradaPerfil> = {}): EntradaPerfil {
  return {
    perfil,
    sessao: { modo: 'novo', sessionId: SID },
    modelo: 'claude-fable-5-1',
    esforco: 'high',
    numeroChamado: 123,
    orcamentoUsd: 5,
    arquivos: {
      settings: '/dados/execucoes/e/settings.1.json',
      sistema: '/dados/execucoes/e/sistema.1.md',
      agentes:
        perfil === 'condutor_t1' || perfil === 'condutor_t2'
          ? '/dados/execucoes/e/agentes.1.json'
          : null,
    },
    jsonSchema: { type: 'object' },
    dirEntrada: perfil === 'planejador' ? '/dados/execucoes/e/entrada' : null,
    cwd: '/dados/worktrees/p/123-abcd1234',
    env: { envOrigem: ENV_APP },
    ...extra,
  };
}

/** Valores de uma flag variádica (até a próxima `--flag`). */
function valores(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const saida: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('--'); j++) saida.push(args[j]!);
  return saida;
}

const BASE = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--forward-subagent-text',
  '--session-id',
  SID,
  '--model',
  'claude-fable-5-1',
  '--effort',
  'high',
  '--settings',
  '/dados/execucoes/e/settings.1.json',
  '--strict-mcp-config',
  '--append-system-prompt-file',
  '/dados/execucoes/e/sistema.1.md',
  '--max-budget-usd',
  '5.00',
];

describe('montarComando: base comum (01 §6.1)', () => {
  it.each(['planejador', 'condutor_t1', 'condutor_t2', 'condutor_t3'] as const)(
    '%s começa com a base comum, nomeia a sessão e passa o schema',
    (perfil) => {
      const c = montarComando(entrada(perfil));
      expect(c.args.slice(0, BASE.length)).toEqual(BASE);
      expect(c.executavel).toBe('claude');
      expect(valores(c.args, '--name')).toEqual([
        `forja-123-${{ planejador: 'planejar', condutor_t1: 'implementar', condutor_t2: 'revisar', condutor_t3: 'relatar' }[perfil]}`,
      ]);
      expect(valores(c.args, '--json-schema')).toEqual(['{"type":"object"}']);
      expect(c.args).not.toContain('--fallback-model');
      expect(c.args).not.toContain('--mcp-config');
      expect(c.cwd).toBe('/dados/worktrees/p/123-abcd1234');
    },
  );

  it('resume troca --session-id por --resume e mantém --model/--effort/--settings', () => {
    const c = montarComando(entrada('condutor_t2', { sessao: { modo: 'resume', sessionId: SID } }));
    expect(c.args).not.toContain('--session-id');
    expect(valores(c.args, '--resume')).toEqual([SID]);
    expect(c.args).toContain('--model');
    expect(c.args).toContain('--settings');
  });

  it('conversar: mesmo perfil, sem --json-schema e sem contrato', () => {
    const c = montarComando(entrada('condutor_t1', { conversar: true }));
    expect(c.args).not.toContain('--json-schema');
    expect(c.contrato).toBeNull();
    expect(c.esperado.comSchema).toBe(false);
    expect(c.args).toContain('--dangerously-skip-permissions');
    expect(valores(c.args, '--name')).toEqual(['forja-123-conversar']);
  });

  it('retomar acrescenta CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1', () => {
    const c = montarComando(entrada('condutor_t1', { retomarTurnoInterrompido: true }));
    expect(c.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe('1');
    expect(
      montarComando(entrada('condutor_t1')).env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN,
    ).toBeUndefined();
  });

  it('--max-turns só quando pedido', () => {
    expect(montarComando(entrada('condutor_t3')).args).not.toContain('--max-turns');
    expect(
      valores(montarComando(entrada('condutor_t3', { maxTurns: 30 })).args, '--max-turns'),
    ).toEqual(['30']);
  });

  it('recusa entradas incoerentes', () => {
    expect(() => montarComando(entrada('condutor_t1', { jsonSchema: null }))).toThrow(ErroPerfil);
    expect(() =>
      montarComando(
        entrada('condutor_t2', { arquivos: { settings: 's', sistema: 'x', agentes: null } }),
      ),
    ).toThrow(ErroPerfil);
    expect(() => montarComando(entrada('planejador', { dirEntrada: null }))).toThrow(ErroPerfil);
    expect(() =>
      montarComando(entrada('planejador', { sessao: { modo: 'novo', sessionId: 'x; rm' } })),
    ).toThrow(ErroPerfil);
  });
});

describe('montarComando: flags por perfil (01 §6.2)', () => {
  it('planejador: --restricted, só leitura, dontAsk, --add-dir da entrada', () => {
    const c = montarComando(entrada('planejador'));
    const resto = c.args.slice(c.args.indexOf('--restricted'));
    expect(resto).toEqual([
      '--restricted',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--add-dir',
      '/dados/execucoes/e/entrada',
    ]);
    expect(c.args).not.toContain('--dangerously-skip-permissions');
    expect(c.args).not.toContain('--agents');
    expect(c.contrato).toBe('plano.v1');
    expect(c.esperado).toMatchObject({ permissionMode: 'dontAsk', agentesAceitos: null });
    expect(c.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('condutor T1: bypass, --agents, nega Agent(x) fora do papel, setting-sources vazio, env FORCE Opus', () => {
    const c = montarComando(entrada('condutor_t1'));
    expect(valores(c.args, '--tools')).toEqual(['Agent,Read,Grep,Glob,Edit,Write,Bash']);
    expect(c.args).toContain('--dangerously-skip-permissions');
    expect(valores(c.args, '--agents')).toEqual(['/dados/execucoes/e/agentes.1.json']);
    const negados = valores(c.args, '--disallowedTools');
    expect(negados).toContain('Agent(general-purpose)');
    expect(negados).toContain('Agent(Explore)');
    expect(negados).not.toContain('Agent(implementador)');
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(c.args).not.toContain('--add-dir');
    expect(c.args).not.toContain('--permission-mode');
    expect(c.env).toMatchObject({
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
    expect(c.contrato).toBe('resumo_impl.v1');
    expect(c.esperado.permissionMode).toBe('bypassPermissions');
    expect(c.esperado.agentesAceitos).toContain('implementador');
    expect(c.esperado.agentesAceitos).toContain('general-purpose');
    expect(c.esperado.modelosPermitidos).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
  });

  it('condutor T1: a lista negada vem do cache e nunca inclui o implementador', () => {
    const c = montarComando(
      entrada('condutor_t1', { agentesNegados: ['Plan', 'implementador', 'Plan', 'plugin-x'] }),
    );
    expect(valores(c.args, '--disallowedTools')).toEqual(['Agent(Plan)', 'Agent(plugin-x)']);
  });

  it('condutor T2: allow efetivo (leitura + checks do projeto, FJ-032), agentes revisores, sem --add-dir', () => {
    const c = montarComando(
      entrada('condutor_t2', { scriptsProjeto: ['npm run build', './scripts/check.sh', 'x (y)'] }),
    );
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(valores(c.args, '--tools')).toEqual(['Agent,Read,Grep,Glob,Bash']);
    expect(valores(c.args, '--allowedTools')).toEqual([
      'Agent(revisor_correcao)',
      'Agent(revisor_seguranca)',
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(git show *)',
      ...ALLOW_CHECKS_T2,
      // Scripts do projeto (dicas, FJ-032); comando com parênteses não vira regra.
      'Bash(npm run build)',
      'Bash(npm run build *)',
      'Bash(./scripts/check.sh)',
      'Bash(./scripts/check.sh *)',
    ]);
    expect(ALLOW_CHECKS_T2).toContain('Bash(npm run *)');
    expect(ALLOW_CHECKS_T2.some((a) => a.includes('git'))).toBe(false);
    expect(valores(c.args, '--permission-mode')).toEqual(['dontAsk']);
    expect(valores(c.args, '--permission-prompts')).toEqual(['none']);
    expect(c.args).not.toContain('--dangerously-skip-permissions');
    expect(c.args).not.toContain('--add-dir');
    expect(c.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
    expect(c.contrato).toBe('veredito.v1');
  });

  it('condutor T3: --restricted, só leitura, sem agentes', () => {
    const c = montarComando(entrada('condutor_t3'));
    expect(c.args.slice(c.args.indexOf('--restricted'))).toEqual([
      '--restricted',
      '--tools',
      'Read,Grep,Glob',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
    ]);
    expect(c.args).not.toContain('--agents');
    expect(c.contrato).toBe('relatorio.v1');
  });
});

describe('env allowlist (01 §6.1, 05 §4.7)', () => {
  it.each(['planejador', 'condutor_t1', 'condutor_t2', 'condutor_t3'] as const)(
    '%s: construído do zero, sem CLAUDECODE, tokens nem SSH_AUTH_SOCK',
    (perfil) => {
      const { env } = montarComando(entrada(perfil));
      for (const proibida of [
        'CLAUDECODE',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_CODE_MESSAGING_TOKEN',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'ANTHROPIC_API_KEY',
        'CHAMADOS_TOKEN',
        'SSH_AUTH_SOCK',
        'GPG_AGENT_INFO',
        'AWS_SECRET_ACCESS_KEY',
        'NODE_OPTIONS',
      ]) {
        expect(env[proibida], proibida).toBeUndefined();
      }
      expect(env).toMatchObject({
        PATH: '/usr/bin',
        HOME: '/home/u',
        LANG: 'pt_BR.UTF-8',
        LC_ALL: 'pt_BR.UTF-8',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      });
      // [V S2] o scrub força `permissionMode: default` e anula bypass/dontAsk.
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    },
  );

  it('API key só por opção explícita; variáveis do projeto passam, proibidas não', () => {
    const env = montarEnvBase({
      envOrigem: ENV_APP,
      apiKey: 'sk-escolhida',
      envProjeto: {
        DATABASE_URL: 'postgres://dev',
        GH_TOKEN: 'x',
        CLAUDE_CODE_X: '1',
        DISABLE_AUTOUPDATER: '0',
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-escolhida');
    expect(env.DATABASE_URL).toBe('postgres://dev');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_X).toBeUndefined();
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    const c = montarComando(
      entrada('condutor_t3', { env: { envOrigem: ENV_APP, apiKey: 'sk-escolhida' } }),
    );
    expect(c.esperado.apiKeySource).toBe('api_key');
  });
});

describe('demais', () => {
  it('orçamento = min(teto, saldo), recusando saldo esgotado', () => {
    expect(orcamentoEtapa(25, 40)).toBe(25);
    expect(orcamentoEtapa(25, 3.456)).toBe(3.45);
    expect(() => orcamentoEtapa(25, 0)).toThrow(ErroPerfil);
  });

  it('atualiza a lista negada a partir do init sem incluir o implementador', () => {
    expect(atualizarAgentesNegados(['Plan'], ['claude', 'implementador', 'novo-plugin'])).toEqual([
      'Plan',
      'claude',
      'novo-plugin',
    ]);
  });

  it('Assumir: TUI sem -p e sem bypass, com settings e zero MCP', () => {
    const c = montarComandoAssumir({
      sessionId: SID,
      settings: '/s.json',
      modelo: 'claude-fable-5-1',
      cwd: '/wt',
      env: { envOrigem: ENV_APP },
    });
    expect(c.args).toEqual([
      '--resume',
      SID,
      '--setting-sources',
      '',
      '--settings',
      '/s.json',
      '--strict-mcp-config',
      '--permission-mode',
      'default',
      '--model',
      'claude-fable-5-1',
    ]);
    expect(c.env.CLAUDECODE).toBeUndefined();
  });

  it('registro do perfil omite o schema e só guarda nomes do env', () => {
    const r = registroPerfil(montarComando(entrada('condutor_t1')));
    expect(r.argv[0]).toBe('claude');
    expect(r.argv.join(' ')).toContain('<json-schema');
    expect(r.env).toContain('PATH');
    expect(r.env.join(',')).not.toContain('/usr/bin');
  });
});

describe('MCP do Chamados e B7 (FJ-030 §3, §4)', () => {
  const mcp = '/dados/execucoes/e/mcp.1.json';
  it.each(['planejador', 'condutor_t1', 'condutor_t2', 'condutor_t3'] as const)(
    '%s: --mcp-config com --strict-mcp-config; em dontAsk as ferramentas do MCP no allow',
    (perfil) => {
      const c = montarComando(
        entrada(perfil, {
          arquivos: { ...entrada(perfil).arquivos, mcp },
        }),
      );
      const i = c.args.indexOf('--mcp-config');
      expect(c.args[i + 1]).toBe(mcp);
      expect(c.args).toContain('--strict-mcp-config');
      expect(c.esperado.mcpChamados).toBe(true);
      if (perfil !== 'condutor_t1') expect(c.args).toContain('mcp__chamados__chamado_obter');
      expect(c.args.join(' ')).not.toMatch(/mcp__chamados__chamado_(criar|publicar|alterar)/);
    },
  );

  it('sem arquivo de MCP: nada de --mcp-config e o init não espera o servidor', () => {
    const c = montarComando(entrada('planejador'));
    expect(c.args).not.toContain('--mcp-config');
    expect(c.args).toContain('--strict-mcp-config');
    expect(c.esperado.mcpChamados).toBe(false);
  });

  it('T1 recebe FORJA_PRINT e FORJA_EVIDENCIAS_DIR; o resto de FORJA_* segue proibido', () => {
    const c = montarComando(
      entrada('condutor_t1', {
        evidencias: { forjaPrint: '/app/forja-print.mjs', dir: '/dados/execucoes/e/evidencias' },
        env: { envOrigem: ENV_APP, envProjeto: { FORJA_TOKEN: 'x' } },
      }),
    );
    expect(c.env.FORJA_PRINT).toBe('/app/forja-print.mjs');
    expect(c.env.FORJA_EVIDENCIAS_DIR).toBe('/dados/execucoes/e/evidencias');
    expect(c.env.FORJA_TOKEN).toBeUndefined();
    expect(
      montarComando(entrada('condutor_t2', { evidencias: { forjaPrint: 'x', dir: 'y' } })).env
        .FORJA_PRINT,
    ).toBeUndefined();
  });
});
