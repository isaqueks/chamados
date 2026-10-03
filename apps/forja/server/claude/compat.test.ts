import { describe, expect, it } from 'vitest';
import {
  avaliarSmoke,
  comandoSmokePerfil,
  compararVersoes,
  detectarBarePadrao,
  itensDiagnosticoCli,
  verificarAuthCli,
  verificarGit,
  verificarVersaoCli,
  VERSAO_CLI_FIXADA,
  type FuncaoExec,
  type SaidaExec,
} from './compat';
import { lerFixture } from './fixtures/processo-falso';
import type { EntradaPerfil } from './perfis';

function execFalso(respostas: Record<string, SaidaExec>): FuncaoExec & { chamadas: string[] } {
  const chamadas: string[] = [];
  const fn = (async (executavel: string, args: string[]) => {
    const chave = `${executavel} ${args.join(' ')}`;
    chamadas.push(chave);
    return respostas[chave] ?? { codigo: 127, stdout: '', stderr: 'não encontrado' };
  }) as FuncaoExec & { chamadas: string[] };
  fn.chamadas = chamadas;
  return fn;
}

describe('checagens de boot (01 §7)', () => {
  it('versão fixada', async () => {
    const ok = execFalso({
      'claude --version': { codigo: 0, stdout: '2.1.288 (Claude Code)\n', stderr: '' },
    });
    expect(await verificarVersaoCli(ok)).toEqual({ encontrada: '2.1.288', ok: true, erro: null });
    const outra = execFalso({
      'claude --version': { codigo: 0, stdout: '2.2.0 (Claude Code)', stderr: '' },
    });
    expect((await verificarVersaoCli(outra)).ok).toBe(false);
    expect((await verificarVersaoCli(execFalso({}))).encontrada).toBeNull();
    expect(VERSAO_CLI_FIXADA).toBe('2.1.288');
  });

  it('auth status: JSON com authMethod/subscriptionType; exit ≠ 0 é sem login', async () => {
    const ok = execFalso({
      'claude auth status': {
        codigo: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'max',
          email: 'x@y',
        }),
        stderr: '',
      },
    });
    const r = await verificarAuthCli(ok);
    expect(r).toEqual({ ok: true, authMethod: 'claude.ai', subscriptionType: 'max', erro: null });
    expect(JSON.stringify(r)).not.toContain('x@y');
    expect(
      (
        await verificarAuthCli(
          execFalso({ 'claude auth status': { codigo: 1, stdout: '', stderr: 'Not logged in' } }),
        )
      ).ok,
    ).toBe(false);
  });

  it('git ≥ 2.38', async () => {
    expect(
      (
        await verificarGit(
          execFalso({ 'git --version': { codigo: 0, stdout: 'git version 2.43.0', stderr: '' } }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await verificarGit(
          execFalso({ 'git --version': { codigo: 0, stdout: 'git version 2.37.9', stderr: '' } }),
        )
      ).ok,
    ).toBe(false);
    expect(compararVersoes('2.38.0', '2.38')).toBe(0);
    expect(compararVersoes('2.1.288', '2.1.300')).toBe(-1);
  });

  it('itens do Diagnóstico bloqueiam o pipeline quando falham', () => {
    const itens = itensDiagnosticoCli(
      { encontrada: '2.2.0', ok: false, erro: null },
      { ok: false, authMethod: null, subscriptionType: null, erro: 'sem login' },
      { encontrada: '2.43.0', ok: true, erro: null },
    );
    expect(itens.map((i) => [i.codigo, i.estado, i.bloqueia])).toEqual([
      ['cli_versao', 'erro', 'pipeline'],
      ['cli_login', 'erro', 'pipeline'],
      ['git_versao', 'ok', null],
    ]);
    expect(itens[0]!.detalhe).toContain('claude install 2.1.288');
  });

  it('--bare como padrão futuro', () => {
    expect(
      detectarBarePadrao({
        classificacao: 'autenticacao',
        authStatusOk: true,
        apiKeySource: 'none',
        usaApiKey: false,
      }),
    ).toBe(true);
    expect(
      detectarBarePadrao({
        classificacao: 'concluido',
        authStatusOk: true,
        apiKeySource: 'ANTHROPIC_API_KEY',
        usaApiKey: false,
      }),
    ).toBe(true);
    expect(
      detectarBarePadrao({
        classificacao: 'concluido',
        authStatusOk: true,
        apiKeySource: 'ANTHROPIC_API_KEY',
        usaApiKey: true,
      }),
    ).toBe(false);
    expect(
      detectarBarePadrao({
        classificacao: 'concluido',
        authStatusOk: true,
        apiKeySource: 'none',
        usaApiKey: false,
      }),
    ).toBe(false);
  });
});

describe('smoke de perfis', () => {
  const entrada = (perfil: EntradaPerfil['perfil']): EntradaPerfil => ({
    perfil,
    sessao: { modo: 'novo', sessionId: '11111111-2222-4333-8444-555555555555' },
    modelo: 'claude-fable-5-1',
    esforco: 'high',
    numeroChamado: 0,
    orcamentoUsd: 5,
    arquivos: { settings: '/s', sistema: '/x', agentes: '/a' },
    jsonSchema: { type: 'object' },
    dirEntrada: '/e',
    cwd: '/tmp',
    env: { envOrigem: {} },
  });

  it('mesmas flags do perfil, mas barato', () => {
    const c = comandoSmokePerfil(entrada('planejador'));
    const v = (f: string) => c.args[c.args.indexOf(f) + 1];
    expect(v('--model')).toBe('haiku');
    expect(v('--max-turns')).toBe('1');
    expect(v('--max-budget-usd')).toBe('0.05');
    expect(v('--tools')).toBe('');
    expect(c.args).toContain('--restricted');
    const t1 = comandoSmokePerfil(entrada('condutor_t1'));
    expect(t1.args[t1.args.indexOf('--tools') + 1]).toBe('Agent,Read,Grep,Glob,Edit,Write,Bash');
    expect(t1.args).toContain('--dangerously-skip-permissions');
  });

  it('avalia o stream: init do perfil, 1 result com structured_output, 1 rate_limit_event', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      capabilities: ['x'],
      apiKeySource: 'none',
      permissionMode: 'dontAsk',
    };
    const ok = [
      init,
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'result', subtype: 'success', structured_output: { ok: true } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    expect(avaliarSmoke({ perfil: 'planejador', stdout: ok, stderr: '', exitCode: 0 })).toEqual({
      ok: true,
      falhas: [],
      capabilities: ['x'],
    });

    // fixture real a: modo default e result sem structured_output
    const a = avaliarSmoke({
      perfil: 'planejador',
      stdout: lerFixture('a.jsonl'),
      stderr: '',
      exitCode: 0,
    });
    expect(a.ok).toBe(false);
    expect(a.falhas).toContain('permissionMode default ≠ dontAsk');
    expect(a.falhas).toContain('result sem structured_output');

    const recusada = avaliarSmoke({
      perfil: 'condutor_t3',
      stdout: '',
      stderr: "error: unknown option '--restricted'",
      exitCode: 1,
    });
    expect(recusada.falhas[0]).toContain('flag recusada');
  });
});
