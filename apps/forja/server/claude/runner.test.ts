import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validarContrato } from '../../comum/contratos';
import { criarSpawnFalso, lerFixture, type ProcessoFalso } from './fixtures/processo-falso';
import { ErroSessaoOcupada, LockSessoes } from './lock-sessoes';
import { montarComando, type ComandoClaude } from './perfis';
import {
  classificarFim,
  ESPERA_ESCADA_MS,
  persistenciaEmArquivos,
  RunnerCli,
  type EntradaProcesso,
  type EventoRunner,
  type InsumosClassificacao,
} from './runner';

const SID = '11111111-2222-4333-8444-555555555555';

function comandoT1(conversar = false): ComandoClaude {
  return montarComando({
    perfil: 'condutor_t1',
    sessao: { modo: 'novo', sessionId: SID },
    conversar,
    modelo: 'claude-fable-5-1',
    esforco: 'high',
    numeroChamado: 7,
    orcamentoUsd: 25,
    arquivos: { settings: '/s.json', sistema: '/sis.md', agentes: '/ag.json' },
    jsonSchema: { type: 'object' },
    cwd: '/wt',
    env: { envOrigem: { PATH: '/usr/bin', HOME: '/home/u', CLAUDECODE: '1' } },
  });
}

const RESUMO_OK = {
  versao: 1,
  ciclo: 1,
  passos: [
    {
      id: 'P1',
      status: 'concluido',
      executor: 'implementador',
      arquivos_alterados: ['src/a.ts'],
      comandos: [{ comando: 'npm test', exit_code: 0 }],
      observacao: 'feito',
    },
  ],
  desvios_do_plano: [],
  dependencias_adicionadas: [],
  telas_afetadas: [],
  achados_tratados: [],
  bloqueios: [],
  resumo_tecnico: 'Tratamento do erro de unicidade.',
};

const INIT_T1 = {
  type: 'system',
  subtype: 'init',
  session_id: SID,
  claude_code_version: '2.1.288',
  permissionMode: 'bypassPermissions',
  tools: ['Task', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'StructuredOutput'],
  mcp_servers: [],
  apiKeySource: 'none',
  agents: ['claude', 'implementador', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
  model: 'claude-fable-5-1',
  plugins: [],
  capabilities: ['interrupt_receipt_v1'],
};

function result(extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 1.5,
    num_turns: 4,
    duration_ms: 1000,
    modelUsage: { 'claude-fable-5-1': { costUSD: 1 }, 'claude-opus-5-5': { costUSD: 0.5 } },
    permission_denials: [],
    result_index: 0,
    structured_output: RESUMO_OK,
    ...extra,
  };
}

const jl = (...objs: object[]) => objs.map((o) => `${JSON.stringify(o)}\n`).join('');

function entrada(extra: Partial<EntradaProcesso> = {}): EntradaProcesso {
  return {
    prompt: '# Insumos do turno\n…',
    execucaoId: 'e1',
    etapaId: 'et1',
    timeoutMs: 60_000,
    ...extra,
  };
}

async function coletar(eventos: AsyncIterable<EventoRunner>): Promise<EventoRunner[]> {
  const todos: EventoRunner[] = [];
  for await (const e of eventos) todos.push(e);
  return todos;
}

describe('RunnerCli com processo falso', () => {
  let sinais: [number, NodeJS.Signals][];
  beforeEach(() => {
    sinais = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function novoRunner(locks?: LockSessoes) {
    const falso = criarSpawnFalso();
    const runner = new RunnerCli({
      spawn: falso.spawn,
      sinalizar: (pg, s) => sinais.push([pg, s]),
      locks,
    });
    return { falso, runner };
  }

  it('spawna detached com env e argv do perfil, escreve o prompt e fecha o stdin', () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    const chamada = falso.chamadas[0]!;
    expect(chamada.executavel).toBe('claude');
    expect(chamada.opcoes).toMatchObject({
      cwd: '/wt',
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(chamada.opcoes.env.CLAUDECODE).toBeUndefined();
    expect(chamada.args).toContain('--dangerously-skip-permissions');
    const p = falso.processos[0]!;
    expect(p.stdinRecebido.join('')).toContain('# Insumos do turno');
    expect(p.stdinFechado).toBe(true);
    expect(exec.pid).toBe(4242);
    expect(exec.pgid).toBe(4242);
    p.sair(0);
  });

  it('stdout em pedaços → eventos, checkpoint do implementador, contrato validado → concluido', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    const coleta = coletar(exec.eventos);
    const p = falso.processos[0]!;
    const stream = jl(
      INIT_T1,
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'ag1',
              name: 'Agent',
              input: { subagent_type: 'implementador', description: 'P1' },
            },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'ag1',
        subagent_type: 'implementador',
        description: 'P1',
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'ag1',
        message: { content: [{ type: 'text', text: 'Editando ação…' }] },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'ARQUIVOS:\nsrc/a.ts' }],
        },
      },
      lerFixture('a.jsonl')
        .split('\n')
        .map((l) => JSON.parse(l || 'null'))
        .find((o) => o?.type === 'rate_limit_event'),
      result(),
    );
    const bytes = Buffer.from(stream, 'utf8');
    for (let i = 0; i < bytes.length; i += 7) p.stdout.emit('data', bytes.subarray(i, i + 7));
    p.sair(0);

    const r = await exec.resultado;
    const eventos = await coleta;
    expect(r.classificacao).toBe('concluido');
    expect(r.saida).toEqual(validarContrato('resumo_impl.v1', RESUMO_OK).data);
    expect(r.errosContrato).toEqual([]);
    expect(r.final?.total_cost_usd).toBe(1.5);
    expect(r.init?.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(
      eventos.some((e) => e.tipo === 'checkpoint' && e.toolUseId === 'ag1' && e.emVoo === 0),
    ).toBe(true);
    expect(eventos.some((e) => e.tipo === 'uso')).toBe(true);
    const texto = eventos.find((e) => e.tipo === 'evento' && e.evento.tipo === 'agente.texto');
    expect(
      texto?.tipo === 'evento' && texto.evento.tipo === 'agente.texto' && texto.evento.dados.texto,
    ).toBe('Editando ação…');
    expect(sinais).toEqual([]);
  });

  it('usa o último result (fixture c: structured_output só no result_index 1)', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(true), entrada());
    falso.processos[0]!.escrever(lerFixture('c.jsonl'));
    falso.processos[0]!.sair(0);
    const r = await exec.resultado;
    expect(r.totalResults).toBe(2);
    expect(r.final?.result_index).toBe(1);
    expect(r.final?.structured_output).toEqual({ palavra: 'banana', via_subagente: true });
    // o init da fixture (haiku, dontAsk) diverge do perfil T1 → aborto por SIGTERM
    expect(r.classificacao).toBe('perfil_divergente');
    expect(sinais[0]).toEqual([4242, 'SIGTERM']);
  });

  it('structured_output fora do contrato → saida_invalida com os erros do zod', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.escrever(
      jl(INIT_T1, result({ structured_output: { ...RESUMO_OK, passos: [] } })),
    );
    falso.processos[0]!.sair(0);
    const r = await exec.resultado;
    expect(r.classificacao).toBe('saida_invalida');
    expect(r.saida).toBeNull();
    expect(r.errosContrato.some((e) => e.startsWith('passos'))).toBe(true);
  });

  it('sem result e sem pedido do app → interrompido; pós-mortem de auth reclassifica', async () => {
    const { falso, runner } = novoRunner();
    const a = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.escrever(jl(INIT_T1));
    falso.processos[0]!.sair(1);
    expect((await a.resultado).classificacao).toBe('interrompido');

    const b = runner.iniciar(comandoT1(), entrada({ verificarAuth: async () => false }));
    falso.processos[1]!.sair(1);
    expect((await b.resultado).classificacao).toBe('autenticacao');
  });

  it('timeout dispara a escada SIGINT → SIGTERM → SIGKILL no grupo', async () => {
    vi.useFakeTimers();
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sinais).toEqual([[4242, 'SIGINT']]);
    await vi.advanceTimersByTimeAsync(ESPERA_ESCADA_MS);
    expect(sinais.map((s) => s[1])).toEqual(['SIGINT', 'SIGTERM']);
    await vi.advanceTimersByTimeAsync(ESPERA_ESCADA_MS);
    expect(sinais.map((s) => s[1])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    falso.processos[0]!.sair(null, 'SIGKILL');
    const r = await exec.resultado;
    expect(r.classificacao).toBe('timeout');
    expect(r.sinal).toBe('SIGKILL');
  });

  it('pausar manda SIGINT e, se o processo sai, não escala', async () => {
    vi.useFakeTimers();
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    const pausa = exec.pausar();
    expect(sinais).toEqual([[4242, 'SIGINT']]);
    falso.processos[0]!.sair(130);
    expect((await pausa).classificacao).toBe('pausado');
    await vi.advanceTimersByTimeAsync(ESPERA_ESCADA_MS * 3);
    expect(sinais).toHaveLength(1);
  });

  it('cancelar depois de pausar vira cancelado, sem reiniciar a escada', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    void exec.pausar();
    void exec.cancelar();
    falso.processos[0]!.sair(130);
    expect((await exec.resultado).classificacao).toBe('cancelado');
    expect(sinais).toEqual([[4242, 'SIGINT']]);
  });

  it('agente fora do papel no init: SIGTERM, perfil_divergente e a lista para o reinício', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    const coleta = coletar(exec.eventos);
    falso.processos[0]!.escrever(jl({ ...INIT_T1, agents: [...INIT_T1.agents, 'plugin-x'] }));
    expect(sinais).toEqual([[4242, 'SIGTERM']]);
    falso.processos[0]!.sair(143);
    const r = await exec.resultado;
    expect(r.classificacao).toBe('perfil_divergente');
    expect(r.agentesForaDoPapel).toEqual(['plugin-x']);
    const alertas = (await coleta).flatMap((e) =>
      e.tipo === 'evento' && e.evento.tipo === 'cli.alerta' ? [e.evento.dados.codigo] : [],
    );
    expect(alertas).toContain('agentes_fora_do_papel');
  });

  it('cota: rate_limit rejeitado sem result → cota com resetsAt', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.escrever(
      jl(INIT_T1, {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1790996400 },
      }),
    );
    falso.processos[0]!.sair(1);
    const r = await exec.resultado;
    expect(r.classificacao).toBe('cota');
    expect(r.resetsAt).toBe('2026-10-03T03:00:00.000Z');
  });

  it('lock por session_id: segundo processo na mesma sessão é recusado até o primeiro sair', async () => {
    const locks = new LockSessoes();
    const { falso, runner } = novoRunner(locks);
    const a = runner.iniciar(comandoT1(), entrada());
    expect(() => runner.iniciar(comandoT1(), entrada())).toThrow(ErroSessaoOcupada);
    expect(falso.chamadas).toHaveLength(1);
    falso.processos[0]!.sair(0);
    await a.resultado;
    expect(locks.dono(SID)).toBeNull();
    const b = runner.iniciar(comandoT1(), entrada());
    falso.processos[1]!.sair(0);
    await b.resultado;
  });

  it('inatividade gera aviso e nunca mata', async () => {
    vi.useFakeTimers();
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(
      comandoT1(),
      entrada({ avisoInatividadeMs: 500, timeoutMs: 100_000 }),
    );
    const coleta = coletar(exec.eventos);
    await vi.advanceTimersByTimeAsync(600);
    expect(sinais).toEqual([]);
    falso.processos[0]!.sair(1);
    const codigos = (await coleta).flatMap((e) =>
      e.tipo === 'evento' && e.evento.tipo === 'cli.alerta' ? [e.evento.dados.codigo] : [],
    );
    expect(codigos).toContain('possivelmente_travado');
  });

  it('modelo fora do perfil no result gera alerta', async () => {
    const { falso, runner } = novoRunner();
    const exec = runner.iniciar(comandoT1(), entrada());
    const coleta = coletar(exec.eventos);
    falso.processos[0]!.escrever(
      jl(INIT_T1, result({ modelUsage: { 'claude-fable-5-1': {}, 'claude-sonnet-5-5': {} } })),
    );
    falso.processos[0]!.sair(0);
    const r = await exec.resultado;
    expect(r.modelosInesperados).toEqual(['claude-sonnet-5-5']);
    expect(
      (await coleta).some(
        (e) =>
          e.tipo === 'evento' &&
          e.evento.tipo === 'cli.alerta' &&
          e.evento.dados.codigo === 'modelo_inesperado',
      ),
    ).toBe(true);
  });

  it('falha no spawn (sem pid) termina sem pendurar', async () => {
    const falso = criarSpawnFalso();
    const runner = new RunnerCli({
      spawn: (e, a, o) => {
        const p = falso.spawn(e, a, o) as ProcessoFalso;
        Object.defineProperty(p, 'pid', { value: undefined });
        queueMicrotask(() => p.emit('error', new Error('spawn claude ENOENT')));
        return p;
      },
      sinalizar: () => undefined,
    });
    const r = await runner.iniciar(comandoT1(), entrada()).resultado;
    expect(r.classificacao).toBe('interrompido');
  });

  it('versão fixada é lida a cada init (Aceitar versão em runtime) e a divergência avisa o compat', async () => {
    const falso = criarSpawnFalso();
    let liberada = '2.1.288';
    const divergencias: { encontrada: string | null; esperada: string }[] = [];
    const runner = new RunnerCli({
      spawn: falso.spawn,
      sinalizar: (pg, s) => sinais.push([pg, s]),
      versaoFixada: () => liberada,
      aoVersaoDivergente: (info) => divergencias.push(info),
    });
    const init300 = { ...INIT_T1, claude_code_version: '2.1.300' };

    const a = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.escrever(jl(init300));
    expect(sinais).toEqual([[4242, 'SIGTERM']]);
    falso.processos[0]!.sair(143);
    expect((await a.resultado).classificacao).toBe('perfil_divergente');
    expect(divergencias).toEqual([{ encontrada: '2.1.300', esperada: '2.1.288' }]);

    liberada = '2.1.300'; // "Aceitar versão 2.1.300" com smoke aprovado
    const b = runner.iniciar(comandoT1(), entrada());
    falso.processos[1]!.escrever(jl(init300, result()));
    falso.processos[1]!.sair(0);
    expect((await b.resultado).classificacao).toBe('concluido');
    expect(divergencias).toHaveLength(1);
  });

  it('verificarAuth padrão do runner vale quando a entrada não traz o seu', async () => {
    const falso = criarSpawnFalso();
    const runner = new RunnerCli({
      spawn: falso.spawn,
      sinalizar: () => undefined,
      verificarAuth: async () => false,
    });
    const exec = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.sair(1);
    expect((await exec.resultado).classificacao).toBe('autenticacao');
  });

  it('timeout varre o cwd antes de resolver (comandos do Bash em setsid, S4)', async () => {
    vi.useFakeTimers();
    const falso = criarSpawnFalso();
    const varridos: string[] = [];
    const runner = new RunnerCli({
      spawn: falso.spawn,
      sinalizar: (pg, s) => sinais.push([pg, s]),
      varrerCwd: async (cwd) => {
        varridos.push(cwd);
        return 1;
      },
    });
    const exec = runner.iniciar(comandoT1(), entrada({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    falso.processos[0]!.sair(130);
    expect((await exec.resultado).classificacao).toBe('timeout');
    expect(varridos).toEqual(['/wt']);

    // Fim normal não varre.
    const b = runner.iniciar(comandoT1(), entrada());
    falso.processos[1]!.escrever(jl(INIT_T1, result()));
    falso.processos[1]!.sair(0);
    await b.resultado;
    expect(varridos).toEqual(['/wt']);
  });

  it('consumidor que abandona o stream (exceção no laço) cancela o processo e varre o cwd', async () => {
    const falso = criarSpawnFalso();
    const varridos: string[] = [];
    const locks = new LockSessoes();
    const runner = new RunnerCli({
      spawn: falso.spawn,
      sinalizar: (pg, s) => sinais.push([pg, s]),
      locks,
      varrerCwd: async (cwd) => {
        varridos.push(cwd);
        return 0;
      },
    });
    const exec = runner.iniciar(comandoT1(), entrada());
    falso.processos[0]!.escrever(jl(INIT_T1));
    await expect(
      (async () => {
        for await (const ev of exec.eventos) {
          if (ev.tipo === 'init') throw new Error('SQLITE_BUSY');
        }
      })(),
    ).rejects.toThrow('SQLITE_BUSY');
    expect(sinais).toEqual([[4242, 'SIGINT']]);
    falso.processos[0]!.sair(130);
    const r = await exec.resultado;
    expect(r.classificacao).toBe('cancelado');
    expect(varridos).toEqual(['/wt']);
    expect(locks.dono(SID)).toBeNull();
  });

  describe('persistência do bruto', () => {
    let dir: string | null = null;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('grava cada linha do stdout em eventos.jsonl e o stderr em stderr.log', async () => {
      dir = await mkdtemp(join(tmpdir(), 'forja-runner-'));
      const { falso, runner } = novoRunner();
      const exec = runner.iniciar(
        comandoT1(),
        entrada({ persistencia: persistenciaEmArquivos(join(dir, 'etapas', '3')) }),
      );
      falso.processos[0]!.escrever(jl(INIT_T1) + 'nao json\n');
      falso.processos[0]!.stderr.emit('data', Buffer.from('Warning: x\n'));
      falso.processos[0]!.sair(1);
      const r = await exec.resultado;
      const bruto = await readFile(join(dir, 'etapas', '3', 'eventos.jsonl'), 'utf8');
      expect(bruto.split('\n').filter(Boolean)).toHaveLength(2);
      expect(await readFile(join(dir, 'etapas', '3', 'stderr.log'), 'utf8')).toBe('Warning: x\n');
      expect(r.stderrFinal).toBe('Warning: x\n');
    });

    it('redige segredos antes de gravar (genéricos e valores conhecidos); a linha segue JSON', async () => {
      dir = await mkdtemp(join(tmpdir(), 'forja-runner-'));
      const { Redator } = await import('../eventos/normalizador');
      const { falso, runner } = novoRunner();
      const exec = runner.iniciar(
        comandoT1(),
        entrada({
          persistencia: persistenciaEmArquivos(
            join(dir, 'etapas', '4'),
            new Redator(['senha-do-banco-123']),
          ),
        }),
      );
      const vazamento = {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: 'DB_PASS=senha-do-banco-123\nGH=ghp_abcdefghijklmnopqrstuvwxyz0123',
            },
          ],
        },
      };
      falso.processos[0]!.escrever(jl(INIT_T1, vazamento));
      falso.processos[0]!.stderr.emit('data', Buffer.from('token sk-ant-api03-abcdefghijkl\n'));
      falso.processos[0]!.sair(1);
      await exec.resultado;
      const bruto = await readFile(join(dir, 'etapas', '4', 'eventos.jsonl'), 'utf8');
      expect(bruto).not.toContain('senha-do-banco-123');
      expect(bruto).not.toContain('ghp_abcdefghij');
      for (const l of bruto.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
      const err = await readFile(join(dir, 'etapas', '4', 'stderr.log'), 'utf8');
      expect(err).not.toContain('sk-ant-api03');
    });
  });
});

describe('classificarFim (01 §6.6)', () => {
  const final = (subtype: string, is_error = false) =>
    ({ subtype, is_error, structured_output: null }) as unknown as InsumosClassificacao['final'];
  const base: InsumosClassificacao = {
    parada: null,
    final: final('success'),
    contratoExigido: true,
    contratoValido: true,
    autenticacaoFalhou: false,
    cota: { textoLimite: false, rateLimitRejeitado: false, retryRateLimitEsgotado: false },
  };
  const semCota = base.cota;

  it.each([
    [{}, 'concluido'],
    [{ contratoValido: false }, 'saida_invalida'],
    [{ contratoExigido: false, contratoValido: false }, 'concluido'],
    [{ final: final('error_max_structured_output_retries', true) }, 'saida_invalida'],
    [{ final: final('error_max_budget_usd', true) }, 'limite_orcamento'],
    [{ final: final('error_max_turns', true) }, 'limite_turnos'],
    [{ final: final('error_during_execution', true) }, 'erro_execucao'],
    [
      { final: final('error_during_execution', true), cota: { ...semCota, textoLimite: true } },
      'cota',
    ],
    [{ final: final('success', true), cota: { ...semCota, textoLimite: true } }, 'cota'],
    // Sucesso com contrato válido vence auth passageira e timeout tardio (achados F10/F16).
    [{ autenticacaoFalhou: true }, 'concluido'],
    [{ parada: 'timeout' }, 'concluido'],
    [{ parada: 'timeout', contratoValido: false }, 'timeout'],
    [{ autenticacaoFalhou: true, contratoValido: false }, 'saida_invalida'],
    // Limite declarado pela CLI vence um texto de cota (falso positivo, F14).
    [
      { final: final('error_max_budget_usd', true), cota: { ...semCota, textoLimite: true } },
      'limite_orcamento',
    ],
    [
      { final: final('error_max_turns', true), cota: { ...semCota, rateLimitRejeitado: true } },
      'limite_turnos',
    ],
    [{ final: null }, 'interrompido'],
    [{ final: null, cota: { ...semCota, retryRateLimitEsgotado: true } }, 'cota'],
    [{ autenticacaoFalhou: true, final: null }, 'autenticacao'],
    [{ parada: 'perfil' }, 'perfil_divergente'],
    [{ parada: 'timeout', final: null }, 'timeout'],
    [{ parada: 'pausa' }, 'pausado'],
    [{ parada: 'cancelamento' }, 'cancelado'],
  ] as [Partial<InsumosClassificacao>, string][])('%j → %s', (mudanca, esperado) => {
    expect(classificarFim({ ...base, ...mudanca })).toBe(esperado);
  });
});
