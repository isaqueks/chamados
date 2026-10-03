import { describe, expect, it } from 'vitest';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import { lerFixture } from './fixtures/processo-falso';
import {
  analisarLinha,
  DivisorLinhas,
  NormalizadorStream,
  normalizarStream,
  resumirEntrada,
  type ContextoNormalizador,
} from './stream';

const ctx: ContextoNormalizador = {
  execucaoId: 'exec-1',
  etapaId: 'etapa-1',
  papelPrincipal: 'condutor',
  turno: 'T1',
};

function doTipo<T extends NovoEventoForja['tipo']>(eventos: NovoEventoForja[], tipo: T) {
  return eventos.filter((e): e is Extract<NovoEventoForja, { tipo: T }> => e.tipo === tipo);
}

describe('DivisorLinhas', () => {
  it('junta linhas partidas entre chunks e não quebra UTF-8 partido', () => {
    const d = new DivisorLinhas();
    const bytes = Buffer.from('{"type":"x","t":"ação"}\n{"type":"y"}\n', 'utf8');
    const linhas: string[] = [];
    // corta no meio do "ç" (2 bytes) e no meio da 2ª linha
    const corte1 = bytes.indexOf(0xa7); // segundo byte de "ç"
    linhas.push(...d.empurrar(bytes.subarray(0, corte1)));
    linhas.push(...d.empurrar(bytes.subarray(corte1, corte1 + 12)));
    linhas.push(...d.empurrar(bytes.subarray(corte1 + 12)));
    linhas.push(...d.finalizar());
    expect(linhas).toEqual(['{"type":"x","t":"ação"}', '{"type":"y"}']);
  });

  it('não impõe limite de tamanho de linha e entrega a última linha sem \\n no fim', () => {
    const d = new DivisorLinhas();
    const grande = `{"type":"result","result":"${'x'.repeat(300_000)}"}`;
    expect(d.empurrar(grande)).toEqual([]);
    expect(d.finalizar()).toEqual([grande]);
  });
});

describe('analisarLinha', () => {
  it('linha que não é JSON vira inválida sem lançar', () => {
    expect(analisarLinha('Warning: no stdin data').tipo).toBe('invalida');
    expect(analisarLinha('[1,2]').tipo).toBe('invalida');
    expect(analisarLinha('{"type":"system"}').tipo).toBe('mensagem');
  });
});

describe('fixtures reais da CLI 2.1.288', () => {
  it('a.jsonl: init, texto, rate_limit e um único result', () => {
    const r = normalizarStream(lerFixture('a.jsonl'), {
      ...ctx,
      turno: null,
      papelPrincipal: 'planejador',
    });
    expect(r.invalidas).toBe(0);
    expect(r.sinais.filter((s) => s.tipo === 'init')).toHaveLength(1);
    expect(r.sinais.filter((s) => s.tipo === 'rate_limit')).toHaveLength(1);
    expect(r.normalizador.totalResults).toBe(1);
    expect(r.normalizador.ultimoResult?.result).toBe('ok');
    const textos = doTipo(r.eventos, 'agente.texto');
    expect(textos.map((t) => t.dados.texto)).toContain('ok');
    expect(textos[0]?.dados.papel_agente).toBe('planejador');
    expect(doTipo(r.eventos, 'cli.alerta')).toHaveLength(0);
  });

  it('b.jsonl: init a cada turno, vários result e vale o de maior result_index', () => {
    const r = normalizarStream(lerFixture('b.jsonl'), ctx);
    expect(r.sinais.filter((s) => s.tipo === 'init')).toHaveLength(4);
    expect(r.normalizador.totalResults).toBe(4);
    const ultimo = r.normalizador.ultimoResult;
    expect(ultimo?.result_index).toBe(3);
    expect(ultimo?.result).toBe('ok3');
    expect(Object.keys(ultimo?.modelUsage ?? {})).toContain('claude-fable-5-1');
    const alertas = doTipo(r.eventos, 'cli.alerta');
    expect(alertas.map((a) => a.dados.codigo)).toEqual(['multiplos_result']);
  });

  it('c.jsonl: subagente com parent_tool_use_id, task_started/notification e structured_output no último result', () => {
    const r = normalizarStream(lerFixture('c.jsonl'), ctx);
    const ultimo = r.normalizador.ultimoResult;
    expect(r.normalizador.totalResults).toBe(2);
    expect(ultimo?.result_index).toBe(1);
    expect(ultimo?.structured_output).toEqual({ palavra: 'banana', via_subagente: true });

    const ferramentas = doTipo(r.eventos, 'agente.ferramenta');
    const agent = ferramentas.find((f) => f.dados.ferramenta === 'Agent');
    expect(agent?.dados.subagente).toBe('eco');
    expect(agent?.dados.parent_tool_use_id).toBeNull();
    expect(agent?.dados.papel_agente).toBe('condutor');

    const falaSub = doTipo(r.eventos, 'agente.texto').find((t) => t.dados.texto === 'banana');
    expect(falaSub?.dados.parent_tool_use_id).toBe(agent?.dados.tool_use_id);
    // "eco" não é um papel da Forja: autoria sem papel, mas ligada ao Agent.
    expect(falaSub?.dados.papel_agente).toBeNull();

    const iniciado = doTipo(r.eventos, 'subagente.iniciado')[0];
    expect(iniciado?.dados).toMatchObject({
      subagente: 'eco',
      tool_use_id: agent?.dados.tool_use_id,
    });
    const concluido = doTipo(r.eventos, 'subagente.concluido')[0];
    expect(concluido?.dados).toMatchObject({
      subagente: 'eco',
      status: 'completed',
      resumo: 'banana',
    });

    const rate = r.sinais.find((s) => s.tipo === 'rate_limit');
    expect(rate?.tipo === 'rate_limit' && rate.info.unifiedWindows?.five_hour?.utilization).toBe(
      0.02,
    );
    // o thinking vazio da CLI não polui o feed
    expect(doTipo(r.eventos, 'agente.texto').every((t) => t.dados.texto.trim().length > 0)).toBe(
      true,
    );
  });
});

describe('NormalizadorStream', () => {
  const assistente = (bloco: object, parent: string | null = null) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { content: [bloco] },
  });

  it('Edit/Write na thread principal do T1 gera agente.fora_do_papel; dentro do subagente, não', () => {
    const n = new NormalizadorStream(ctx);
    const principal = n.processar(
      assistente({ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } }),
    );
    expect(doTipo(principal.eventos, 'agente.fora_do_papel')[0]?.dados).toMatchObject({
      ferramenta: 'Edit',
      alvo: 'src/a.ts',
    });
    n.processar(
      assistente({
        type: 'tool_use',
        id: 'ag',
        name: 'Agent',
        input: { subagent_type: 'implementador' },
      }),
    );
    const sub = n.processar(
      assistente(
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/b.ts' } },
        'ag',
      ),
    );
    expect(doTipo(sub.eventos, 'agente.fora_do_papel')).toHaveLength(0);
    expect(doTipo(sub.eventos, 'agente.ferramenta')[0]?.dados.papel_agente).toBe('implementador');
    const bash = n.processar(
      assistente({ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git diff' } }),
    );
    expect(doTipo(bash.eventos, 'agente.fora_do_papel')).toHaveLength(0);
  });

  it('fora do T1 não marca fora_do_papel', () => {
    const n = new NormalizadorStream({ ...ctx, turno: 'T2' });
    const s = n.processar(
      assistente({ type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: 'a' } }),
    );
    expect(doTipo(s.eventos, 'agente.fora_do_papel')).toHaveLength(0);
  });

  it('tool_result síncrono do implementador dispara o checkpoint com a contagem em voo', () => {
    const n = new NormalizadorStream(ctx);
    n.processar(
      assistente({
        type: 'tool_use',
        id: 'a1',
        name: 'Agent',
        input: { subagent_type: 'implementador' },
      }),
    );
    n.processar(
      assistente({
        type: 'tool_use',
        id: 'a2',
        name: 'Agent',
        input: { subagent_type: 'implementador' },
      }),
    );
    const r1 = n.processar({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'ARQUIVOS: …' }] },
    });
    expect(r1.sinais).toEqual([{ tipo: 'implementador_retornou', toolUseId: 'a1', emVoo: 1 }]);
    expect(doTipo(r1.eventos, 'agente.resultado_ferramenta')[0]?.dados.tool_use_id).toBe('a1');
  });

  it('tool_result assíncrono não fecha o implementador; o task_notification fecha', () => {
    const n = new NormalizadorStream(ctx);
    n.processar(
      assistente({
        type: 'tool_use',
        id: 'a1',
        name: 'Agent',
        input: { subagent_type: 'implementador' },
      }),
    );
    const lancado = n.processar({
      type: 'user',
      tool_use_result: { isAsync: true, status: 'async_launched' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched' }],
      },
    });
    expect(lancado.sinais).toEqual([]);
    const fim = n.processar({
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'a1',
      status: 'completed',
      summary: 'ok',
    });
    expect(fim.sinais).toEqual([{ tipo: 'implementador_retornou', toolUseId: 'a1', emVoo: 0 }]);
  });

  it('permission_denials do result viram permissao.negada; git push é erro; sem duplicar', () => {
    const n = new NormalizadorStream(ctx);
    const neg = {
      tool_name: 'Bash',
      tool_use_id: 'p1',
      tool_input: { command: 'git push origin main' },
    };
    const a = n.processar({ type: 'system', subtype: 'permission_denied', ...neg });
    const b = n.processar({ type: 'result', subtype: 'success', permission_denials: [neg] });
    const negadas = [
      ...doTipo(a.eventos, 'permissao.negada'),
      ...doTipo(b.eventos, 'permissao.negada'),
    ];
    expect(negadas).toHaveLength(1);
    expect(negadas[0]?.nivel).toBe('erro');
  });

  it('api_retry authentication_failed vira alerta bloqueante e sinal', () => {
    const n = new NormalizadorStream(ctx);
    const s = n.processar({
      type: 'system',
      subtype: 'api_retry',
      error: 'authentication_failed',
      attempt: 1,
      max_retries: 10,
    });
    expect(s.sinais[0]).toMatchObject({ tipo: 'api_retry', erro: 'authentication_failed' });
    expect(doTipo(s.eventos, 'cli.alerta')[0]?.dados).toEqual({
      codigo: 'login',
      bloqueante: true,
    });
  });

  it('texto "hit your limit" marca cota só na mensagem sintética da CLI (thread principal)', () => {
    const texto = "You've hit your session limit · resets 3pm";
    const sintetica = assistente({ type: 'text', text: texto });
    (sintetica.message as { model?: string }).model = '<synthetic>';
    const n = new NormalizadorStream(ctx);
    n.processar(sintetica);
    expect(n.textoLimiteCota).toBe(true);

    // Texto do modelo (ex.: um repo que implementa rate limiting) não é sinal de cota.
    const doModelo = new NormalizadorStream(ctx);
    doModelo.processar(
      assistente({ type: 'text', text: 'quando o cliente hit your API limit, devolver 429' }),
    );
    expect(doModelo.textoLimiteCota).toBe(false);
  });

  it('linha inválida gera alerta e o parser segue', () => {
    const r = normalizarStream(`lixo\n${lerFixture('a.jsonl')}`, ctx);
    expect(r.invalidas).toBe(1);
    expect(doTipo(r.eventos, 'cli.alerta')[0]?.dados.codigo).toBe('linha_nao_json');
    expect(r.normalizador.totalResults).toBe(1);
  });

  it('texto longo é truncado no evento (o bruto fica no eventos.jsonl)', () => {
    const n = new NormalizadorStream(ctx);
    const s = n.processar(assistente({ type: 'text', text: 'a'.repeat(5000) }));
    const t = doTipo(s.eventos, 'agente.texto')[0];
    expect(t?.dados.truncado).toBe(true);
    expect(t?.dados.texto.length).toBe(2000);
  });
});

describe('resumirEntrada', () => {
  it('resume por ferramenta em uma linha', () => {
    expect(resumirEntrada('Bash', { command: 'npm test\n-- --run' })).toBe('npm test -- --run');
    expect(resumirEntrada('Agent', { subagent_type: 'implementador', description: 'P1' })).toBe(
      'implementador: P1',
    );
    expect(resumirEntrada('Grep', { pattern: 'foo', path: 'src' })).toBe('foo em src');
  });
});
