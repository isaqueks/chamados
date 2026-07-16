import { describe, it, expect } from 'vitest';
import {
  Natureza,
  Prioridade,
  Complexidade,
  type AIProviderInput,
  type AIMapeamentoInput,
} from '@chamados/shared';
import {
  ClaudeAgentProvider,
  mapearResultado,
  montarPrompt,
  montarEnvSdk,
  validarCredenciaisClaude,
  type MensagemSdk,
  type QueryFn,
  type QueryMapFn,
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

function inputMapeamento(): AIMapeamentoInput {
  return {
    sistemaAlvo: { nome: 'Loja', descricao: null, stack: 'bd: postgres' },
    ferramentas: {
      repo_buscar: async () => [],
      repo_ler_arquivo: async () => '',
      repo_arvore: async () => [],
    },
    limites: { timeoutMs: 1000, budgetUsd: 5, maxTurnos: 10 },
    maxChars: 200,
  };
}

/** queryFn falsa que emite as mensagens SDK fornecidas. */
function queryFnDe(...msgs: MensagemSdk[]): QueryFn {
  return async function* () {
    for (const m of msgs) yield m;
  };
}

/** queryMapFn falsa que emite as mensagens SDK fornecidas. */
function queryMapFnDe(...msgs: MensagemSdk[]): QueryMapFn {
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

  it('montarPrompt injeta o conhecimento do sistema quando presente (D-013)', () => {
    const input = inputBase();
    input.contexto.conhecimento = {
      resumo: '# Mapa\n\nRégua usa os canais X e Y (src/regua.ts).',
      commit: 'abc1234',
      geradoEm: '2026-07-16T00:00:00Z',
    };
    const prompt = montarPrompt(input);
    expect(prompt).toContain('<conhecimento_do_sistema>');
    expect(prompt).toContain('src/regua.ts');
    expect(prompt).toContain('abc1234');
  });

  it('telemetria SOMA tokens de todos os turnos (inclui cache) quando não há modelUsage', async () => {
    const queryFn: QueryFn = async function* () {
      yield { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } };
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 7 } },
      };
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        duration_ms: 100,
        structured_output: { compreendido: true, confianca: 0.8 },
      };
    };
    const p = new ClaudeAgentProvider({ queryFn });
    const r = await p.executarTriagem(inputBase());
    expect(r.telemetria.tokensEntrada).toBe(130); // 10 + 20 + 100 (cache_read)
    expect(r.telemetria.tokensSaida).toBe(12); // 5 + 7
  });

  it('telemetria prefere modelUsage cumulativo do result (inclui cache)', async () => {
    const queryFn: QueryFn = async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.02,
        duration_ms: 50,
        // Bug de D-013: usage do result só reflete o último turno (input=6).
        usage: { input_tokens: 6, output_tokens: 3886 },
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 5000,
            cacheReadInputTokens: 90000,
            cacheCreationInputTokens: 1000,
            outputTokens: 3886,
          },
        },
        structured_output: { compreendido: true, confianca: 0.9 },
      };
    };
    const p = new ClaudeAgentProvider({ queryFn });
    const r = await p.executarTriagem(inputBase());
    expect(r.telemetria.tokensEntrada).toBe(96000); // 5000 + 90000 + 1000 (NÃO 6)
    expect(r.telemetria.tokensSaida).toBe(3886);
  });
});

describe('ClaudeAgentProvider — mapeamento (D-013)', () => {
  it('mapearSistema devolve o resumo (texto do result) + telemetria', async () => {
    const queryMapFn = queryMapFnDe(
      { type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 100 } } },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.05,
        duration_ms: 3000,
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 1000,
            cacheReadInputTokens: 500,
            cacheCreationInputTokens: 0,
            outputTokens: 100,
          },
        },
        result: '# Mapa do sistema\n\nRegra de negócio em src/regra.ts',
      },
    );
    const p = new ClaudeAgentProvider({ queryFn: queryFnDe(RESULTADO_SUCESSO), queryMapFn });
    const r = await p.mapearSistema(inputMapeamento());
    expect(r.resumo).toContain('src/regra.ts');
    expect(r.telemetria.tokensEntrada).toBe(1500); // 1000 + 500 cache
    expect(r.telemetria.tokensSaida).toBe(100);
    expect(r.telemetria.custoUsd).toBe(0.05);
  });

  it('mapearSistema trunca o resumo ao maxChars', async () => {
    const longo = 'x'.repeat(500);
    const queryMapFn = queryMapFnDe({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      duration_ms: 10,
      result: longo,
    });
    const p = new ClaudeAgentProvider({ queryFn: queryFnDe(RESULTADO_SUCESSO), queryMapFn });
    const r = await p.mapearSistema(inputMapeamento()); // maxChars: 200
    expect(r.resumo.length).toBe(200);
  });

  it('mapearSistema com resultado vazio lança', async () => {
    const queryMapFn = queryMapFnDe({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      duration_ms: 10,
      result: '   ',
    });
    const p = new ClaudeAgentProvider({ queryFn: queryFnDe(RESULTADO_SUCESSO), queryMapFn });
    await expect(p.mapearSistema(inputMapeamento())).rejects.toThrow(/mapeamento_vazio/);
  });
});

describe('ClaudeAgentProvider — autenticação (D-012)', () => {
  it('montarEnvSdk MESCLA com process.env (não substitui): preserva PATH', () => {
    // O env do subprocesso do SDK substitui o ambiente inteiro — por isso o merge
    // com process.env é obrigatório (senão o subprocesso perderia PATH etc.).
    const env = montarEnvSdk({ apiKey: 'sk-teste' });
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-teste');
  });

  it('montarEnvSdk injeta a API key e o token de assinatura quando presentes', () => {
    const env = montarEnvSdk({ apiKey: 'sk-teste', oauthToken: 'oauth-xyz' });
    // Ambas repassadas; a precedência (API key vence) é resolvida pela cadeia do CLI.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-teste');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-xyz');
  });

  it('montarEnvSdk aceita só o token de assinatura', () => {
    const env = montarEnvSdk({ oauthToken: 'oauth-xyz' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-xyz');
    expect(env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
  });

  it('validarCredenciaisClaude falha sem NENHUMA credencial (mensagem acionável)', () => {
    expect(() => validarCredenciaisClaude({})).toThrow(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => validarCredenciaisClaude({ apiKey: 'sk' })).not.toThrow();
    expect(() => validarCredenciaisClaude({ oauthToken: 'oauth' })).not.toThrow();
  });

  it('construir o provider REAL (sem queryFn) sem credencial falha na inicialização', () => {
    // Sem `queryFn` injetada → monta o transporte real → valida credenciais (via opts)
    // já na construção. O guard checa as opções, não o ambiente do processo de teste.
    expect(() => new ClaudeAgentProvider({ modelo: 'claude-opus-4-8' })).toThrow(
      /IA_PROVIDER=claude requer credencial/,
    );
  });

  it('construir o provider REAL com apiKey NÃO lança (constrói o transporte)', () => {
    expect(
      () => new ClaudeAgentProvider({ modelo: 'claude-opus-4-8', apiKey: 'sk' }),
    ).not.toThrow();
  });
});
