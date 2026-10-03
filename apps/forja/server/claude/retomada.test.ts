import { describe, expect, it } from 'vitest';
import type { ComandoClaude } from './perfis';
import {
  deveFalharAposRetomadas,
  montarPromptSessaoNova,
  resumeFalhou,
  retomarEtapa,
  type DepsRetomada,
} from './retomada';
import type { ExecucaoProcesso, ResultadoProcesso, Runner } from './runner';

function resultado(extra: Partial<ResultadoProcesso> = {}): ResultadoProcesso {
  return {
    classificacao: 'concluido',
    sessionId: 's',
    contrato: 'resumo_impl.v1',
    saida: {},
    errosContrato: [],
    final: null,
    totalResults: 1,
    resetsAt: null,
    init: { ok: true } as ResultadoProcesso['init'],
    agentesForaDoPapel: [],
    modelosInesperados: [],
    exitCode: 0,
    sinal: null,
    duracaoMs: 120_000,
    stderrFinal: '',
    ...extra,
  };
}

describe('resumeFalhou (01 §6.7 passo 3)', () => {
  it.each([
    [{ stderrFinal: 'Error: No conversation found with session ID: abc' }, true],
    [{ init: null, classificacao: 'interrompido' as const }, true],
    [{ classificacao: 'erro_execucao' as const, duracaoMs: 5_000 }, true],
    [{ classificacao: 'erro_execucao' as const, duracaoMs: 90_000 }, false],
    [{ init: null, classificacao: 'pausado' as const }, false],
    // Sem login/cota a sessão nova falharia igual: não troca a session_id do condutor.
    [{ init: null, classificacao: 'autenticacao' as const }, false],
    [{ init: null, classificacao: 'cota' as const }, false],
    [{}, false],
  ])('%j → %s', (extra, esperado) => {
    expect(resumeFalhou(resultado(extra))).toBe(esperado);
  });

  it('duas falhas seguidas levam à falha', () => {
    expect(deveFalharAposRetomadas(1)).toBe(false);
    expect(deveFalharAposRetomadas(2)).toBe(true);
  });
});

function runnerFalso(resultados: ResultadoProcesso[]) {
  const chamadas: { comando: ComandoClaude; prompt: string }[] = [];
  const runner: Runner = {
    iniciar(comando, entrada) {
      chamadas.push({ comando, prompt: entrada.prompt });
      const r = resultados.shift()!;
      return { resultado: Promise.resolve(r) } as unknown as ExecucaoProcesso;
    },
  };
  return { runner, chamadas };
}

function deps(runner: Runner, ordem: string[]): DepsRetomada {
  return {
    runner,
    checkpointSeSujo: async () => {
      ordem.push('checkpoint');
      return 'c'.repeat(40);
    },
    montarComando: (sessao, retomar) =>
      ({
        sessionId: sessao.sessionId,
        args: [sessao.modo],
        env: retomar ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' } : {},
      }) as unknown as ComandoClaude,
    resumoEstado: async () => 'P1 concluído; P2 em andamento',
    promptSessaoNova: async () =>
      montarPromptSessaoNova([], {
        passosConcluidos: 'abc forja: passo P1',
        diffAtual: '1 file',
        vereditosAnteriores: null,
        comentariosAnteriores: [],
      }),
    novoSessionId: () => 'nova',
    entrada: { execucaoId: 'e', etapaId: 'et', timeoutMs: 1000 },
  };
}

describe('retomarEtapa', () => {
  it('checkpoint antes, resume com env de turno interrompido e prompt "retome; estado atual"', async () => {
    const ordem: string[] = [];
    const { runner, chamadas } = runnerFalso([resultado()]);
    const r = await retomarEtapa('antiga', deps(runner, ordem));
    expect(ordem).toEqual(['checkpoint']);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.comando.sessionId).toBe('antiga');
    expect(chamadas[0]!.comando.args).toEqual(['resume']);
    expect(chamadas[0]!.comando.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe('1');
    expect(chamadas[0]!.prompt).toContain('P1 concluído; P2 em andamento');
    expect(r).toMatchObject({
      sessionId: 'antiga',
      sessaoNova: false,
      shaCheckpoint: 'c'.repeat(40),
    });
  });

  it('resume que falha abre sessão nova com o estado atual montado pelo app', async () => {
    const { runner, chamadas } = runnerFalso([
      resultado({
        classificacao: 'erro_execucao',
        init: null,
        stderrFinal: 'No conversation found',
      }),
      resultado({ sessionId: 'nova' }),
    ]);
    const r = await retomarEtapa('antiga', deps(runner, []));
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]!.comando.sessionId).toBe('nova');
    expect(chamadas[1]!.comando.args).toEqual(['novo']);
    expect(chamadas[1]!.prompt).toContain('forja: passo P1');
    expect(chamadas[1]!.prompt).toContain('sessão nova');
    expect(r.sessaoNova).toBe(true);
    expect(r.sessionId).toBe('nova');
    expect(r.resumeFalho?.classificacao).toBe('erro_execucao');
  });
});
