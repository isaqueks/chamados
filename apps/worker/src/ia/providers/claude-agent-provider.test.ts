import { describe, it, expect } from 'vitest';
import { Natureza, Prioridade, Complexidade, type AIProviderInput } from '@chamados/shared';
import {
  ClaudeAgentProvider,
  mapearResultado,
  montarPrompt,
  type MensagemSdk,
  type QueryFn,
} from './claude-agent-provider';
import { ErroProviderBudget, ErroProviderTimeout } from '../erros';

/**
 * Testa o MAPEAMENTO do ClaudeAgentProvider mockando a FRONTEIRA do SDK
 * (`queryFn`) — SEM rede e SEM exigir ANTHROPIC_API_KEY (specs/05 §10).
 */

function inputBase(): AIProviderInput {
  return {
    contexto: {
      titulo: 'Erro ao salvar',
      naturezaDeclarada: Natureza.problema,
      timeline: [
        { id: 'm1', autorPapel: 'cliente', corpo: 'Falha 500', criadaEm: '2026-07-15T00:00:00Z' },
      ],
      sistemaAlvo: { nome: 'Loja', descricao: null, stack: 'bd: postgres' },
    },
    ferramentas: {
      repo_buscar: async () => [],
      repo_ler_arquivo: async () => '',
      logs_consultar: async () => [],
      bd_consultar: async () => [],
    },
    limites: { timeoutMs: 1000, budgetUsd: 1, maxTurnos: 5 },
  };
}

/** queryFn falsa que emite as mensagens SDK fornecidas. */
function queryFnDe(...msgs: MensagemSdk[]): QueryFn {
  return async function* () {
    for (const m of msgs) yield m;
  };
}

const RESULTADO_SUCESSO: MensagemSdk = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.1234,
  duration_ms: 4200,
  num_turns: 3,
  usage: { input_tokens: 1500, output_tokens: 300 },
  structured_output: {
    compreendido: true,
    confianca: 0.82,
    perguntasAoCliente: null,
    complexidade: 'medio',
    naturezaAjustada: 'problema',
    prioridadeSugerida: 'alta',
    diagnostico: 'Timeout no serviço de pedidos.',
    spec: null,
    tentativaResolucao: null,
  },
};

describe('ClaudeAgentProvider — mapeamento SDK → AIProviderResult', () => {
  it('mapeia structured_output + telemetria real', async () => {
    const p = new ClaudeAgentProvider({ queryFn: queryFnDe(RESULTADO_SUCESSO) });
    const r = await p.executarTriagem(inputBase());

    expect(r.compreendido).toBe(true);
    expect(r.confianca).toBe(0.82);
    expect(r.complexidade).toBe(Complexidade.medio);
    expect(r.naturezaAjustada).toBe(Natureza.problema);
    expect(r.prioridadeSugerida).toBe(Prioridade.alta);
    expect(r.diagnostico).toContain('Timeout');
    expect(r.telemetria).toEqual({
      custoUsd: 0.1234,
      duracaoMs: 4200,
      tokensEntrada: 1500,
      tokensSaida: 300,
    });
    expect(p.nome).toBe('claude-agent-sdk');
    expect(p.modelo).toBe('claude-opus-4-8');
  });

  it('extrai o resultado do texto (result JSON) quando não há structured_output', () => {
    const msg: MensagemSdk = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      duration_ms: 10,
      usage: { input_tokens: 5, output_tokens: 2 },
      result:
        'Segue a análise: {"compreendido": false, "confianca": 0.2, "perguntasAoCliente": ["Qual erro?"]}',
    };
    const r = mapearResultado(msg, Date.now());
    expect(r.compreendido).toBe(false);
    expect(r.perguntasAoCliente).toEqual(['Qual erro?']);
    expect(r.complexidade).toBeNull();
  });

  it('subtype error_max_budget_usd vira ErroProviderBudget', async () => {
    const p = new ClaudeAgentProvider({
      queryFn: queryFnDe({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }),
    });
    await expect(p.executarTriagem(inputBase())).rejects.toBeInstanceOf(ErroProviderBudget);
  });

  it('erro genérico do SDK propaga como Error', () => {
    expect(() =>
      mapearResultado(
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
        Date.now(),
      ),
    ).toThrow('boom');
  });

  it('ausência de mensagem de resultado lança erro', async () => {
    const p = new ClaudeAgentProvider({ queryFn: queryFnDe({ type: 'assistant' }) });
    await expect(p.executarTriagem(inputBase())).rejects.toThrow(/resultado/);
  });

  it('timeout (abort) vira ErroProviderTimeout', async () => {
    // queryFn que nunca resolve até o abort disparar.
    const queryFn: QueryFn = async function* ({ abortController }) {
      await new Promise<void>((_resolve, reject) => {
        abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield { type: 'result', subtype: 'success' };
    };
    const p = new ClaudeAgentProvider({ queryFn });
    const input = inputBase();
    input.limites.timeoutMs = 20;
    await expect(p.executarTriagem(input)).rejects.toBeInstanceOf(ErroProviderTimeout);
  });

  it('montarPrompt demarca dados não confiáveis do cliente', () => {
    const prompt = montarPrompt(inputBase());
    expect(prompt).toContain('<chamado_dados_nao_confiaveis>');
    expect(prompt).toContain('Erro ao salvar');
  });
});
