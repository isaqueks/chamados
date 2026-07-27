import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  Natureza,
  Prioridade,
  Papel,
  Complexidade,
  type AIProviderInput,
  type AIMapeamentoInput,
} from '@chamados/shared';
import {
  ClaudeAgentProvider,
  mapearResultado,
  montarPrompt,
  montarSystemPrompt,
  montarEnvSdk,
  validarCredenciaisClaude,
  avaliarPermissaoNativa,
  criarCanUseTool,
  FERRAMENTAS_NATIVAS,
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
      descricao: 'Ao clicar em salvar o pedido aparece um erro 500 e nada é gravado.',
      naturezaDeclarada: Natureza.problema,
      prioridadeDeclarada: Prioridade.media,
      solicitante: { nome: 'Ana Cliente', papel: Papel.cliente },
      timeline: [
        {
          id: 'm1',
          autorPapel: 'cliente',
          autorNome: 'Ana Cliente',
          visibilidade: 'publica',
          corpo: 'Falha 500',
          criadaEm: '2026-07-15T00:00:00Z',
        },
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
    confianca: 'alta',
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
    expect(r.confianca).toBe('alta');
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
    // D-025: número legado (0.2) é mapeado para a faixa categórica.
    expect(r.confianca).toBe('baixa');
  });

  it('confiança é CATEGÓRICA (D-025): aceita baixa/media/alta; número legado vira faixa; lixo = baixa', () => {
    const com = (confianca: unknown) =>
      mapearResultado(
        {
          type: 'result',
          subtype: 'success',
          structured_output: { compreendido: true, confianca },
        },
        Date.now(),
      ).confianca;
    expect(com('media')).toBe('media');
    expect(com('alta')).toBe('alta');
    expect(com(0.9)).toBe('alta');
    expect(com(0.5)).toBe('media');
    expect(com(0.1)).toBe('baixa');
    // Fail-closed: valor desconhecido nunca habilita resolução automática.
    expect(com('altíssima')).toBe('baixa');
    expect(com(undefined)).toBe('baixa');
  });

  it('subtype error_max_budget_usd vira ErroProviderBudget', async () => {
    const p = new ClaudeAgentProvider({
      queryFn: queryFnDe({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }),
    });
    await expect(p.executarTriagem(inputBase())).rejects.toBeInstanceOf(ErroProviderBudget);
  });

  it('saída ILEGÍVEL (sem structured_output e sem JSON no texto) lança, nunca degrada', () => {
    // Incidente 2026-07-22: o `{}` silencioso virava "não entendeu" vazio e o
    // aplicador publicava questionário genérico ao cliente. Agora é FALHA do
    // provider (→ escalonamento a humano), com o texto cru indo ao log.
    const registros: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const log = (msg: string, extra?: Record<string, unknown>) => registros.push({ msg, extra });
    const semJson: MensagemSdk = {
      type: 'result',
      subtype: 'success',
      result: 'Analisei o chamado e concluí que se trata de um pedido de layout.',
    };
    expect(() => mapearResultado(semJson, Date.now(), undefined, log)).toThrow(
      'saida_estruturada_ilegivel',
    );
    expect(registros[0]?.extra?.trecho).toContain('pedido de layout');

    const jsonQuebrado: MensagemSdk = {
      type: 'result',
      subtype: 'success',
      result: '{"compreendido": false, "spec": "linha 1\nlinha 2}',
    };
    expect(() => mapearResultado(jsonQuebrado, Date.now())).toThrow('saida_estruturada_ilegivel');
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

  it('montarPrompt inclui a DESCRIÇÃO do chamado (o pedido do cliente) — D-014', () => {
    const input = inputBase();
    input.contexto.descricao = 'Adicionar envio de mensagem também para clientes com agendamento.';
    const prompt = montarPrompt(input);
    // A descrição é O pedido do cliente — precisa aparecer no input do provider
    // (antes de D-014 ela era omitida: entrada_tem_descricao=false).
    expect(prompt).toContain('DESCRIÇÃO DO CHAMADO');
    expect(prompt).toContain('clientes com agendamento');
    // Continua demarcada como conteúdo não confiável + traz solicitante/prioridade.
    expect(prompt).toContain('<chamado_dados_nao_confiaveis>');
    expect(prompt).toContain('Ana Cliente');
    expect(prompt).toContain('prioridade_declarada: media');
  });

  it('montarPrompt demarca DUAS seções: conversa com o cliente e notas internas (D-015)', () => {
    const input = inputBase();
    input.contexto.timeline = [
      {
        id: 'p1',
        autorPapel: 'cliente',
        autorNome: 'Ana Cliente',
        visibilidade: 'publica',
        corpo: 'O relatório não abre',
        criadaEm: '2026-07-15T00:00:00Z',
      },
      {
        id: 'i1',
        autorPapel: 'operador',
        autorNome: 'Bruno Operador',
        visibilidade: 'interna',
        corpo: 'Priorize a hipótese de timeout no banco',
        criadaEm: '2026-07-15T00:05:00Z',
      },
      {
        id: 'i2',
        autorPapel: 'agente_ia',
        autorNome: 'Assistente IA',
        visibilidade: 'interna',
        corpo: 'Análise anterior: falha no serviço de relatórios',
        criadaEm: '2026-07-15T00:06:00Z',
      },
    ];
    const prompt = montarPrompt(input);
    expect(prompt).toContain('Conversa com o cliente (visível ao cliente)');
    expect(prompt).toContain('Notas internas da equipe (NUNCA visíveis ao cliente)');
    // A mensagem pública fica na 1ª seção; as internas (orientação do operador +
    // análise anterior da IA) ficam na 2ª — ambas dentro do bloco não confiável.
    expect(prompt).toContain('O relatório não abre');
    expect(prompt).toContain('Priorize a hipótese de timeout no banco');
    expect(prompt).toContain('Análise anterior: falha no serviço de relatórios');
    expect(prompt).toContain('<chamado_dados_nao_confiaveis>');
    // A seção pública vem ANTES da seção interna no prompt.
    expect(prompt.indexOf('Conversa com o cliente')).toBeLessThan(
      prompt.indexOf('Notas internas da equipe'),
    );
  });

  it('montarSystemPrompt impõe a separação técnico/cliente e descreve respostaAoCliente (D-015)', () => {
    const sp = montarSystemPrompt();
    expect(sp).toContain('respostaAoCliente');
    expect(sp).toMatch(
      /JAMAIS cont[eé]m detalhes t[eé]cnicos|nunca cont[eé]m detalhes t[eé]cnicos/i,
    );
    expect(sp).toContain('CONTINUIDADE');
  });

  it('montarSystemPrompt deixa claro que é um CHAT e que ambiguidade → perguntar', () => {
    const sp = montarSystemPrompt();
    expect(sp).toContain('CONVERSA CONTÍNUA');
    expect(sp).toContain('isto é um CHAT');
    expect(sp).toMatch(/AMBÍGUA[\s\S]*NÃO ASSUMA/);
    expect(sp).toContain('acionado DE NOVO a cada nova mensagem');
    // Sem saudação repetida: só na PRIMEIRA interação do chamado.
    expect(sp).toContain('NÃO cumprimente a cada mensagem');
  });

  it('montarSystemPrompt condiciona a escrita a facil e proíbe anunciar "resolvido" (D-022)', () => {
    const sp = montarSystemPrompt();
    // Escrita de código APENAS quando a própria IA classificou complexidade=facil.
    expect(sp).toMatch(/complexidade = "facil"/);
    expect(sp).toMatch(/"medio" ou[\s\S]*"dificil", NÃO toque em código/);
    // A alteração é PROPOSTA em PR com revisão humana — nunca "resolvido" ao cliente.
    expect(sp).toContain('REVISÃO HUMANA');
    expect(sp).toMatch(/JAMAIS diga ao cliente[\s\S]*"foi resolvido\/corrigido"/);
    // D-023: alteração simples (facil) também é implementável — não só problema.
    expect(sp).toContain('ALTERAÇÃO simples (D-023)');
  });

  it('montarSystemPrompt anuncia formatação markdown e a ferramenta de artefatos (D-026)', () => {
    const sp = montarSystemPrompt();
    // Formatação: o modelo sabe que markdown vira formatação real na resposta.
    expect(sp).toContain('FORMATAÇÃO');
    expect(sp).toMatch(/MARKDOWN[\s\S]*renderizado/);
    // Artefatos: usar quando o cliente PEDE um material; anexado à resposta pública.
    expect(sp).toContain('ARTEFATOS ENTREGÁVEIS');
    expect(sp).toContain('artefato_gerar');
    expect(sp).toMatch(/anexado automaticamente/);
    expect(sp).toMatch(/NÃO gere artefatos que o cliente não pediu/);
    // Conteúdo do artefato segue as regras de linguagem do cliente.
    expect(sp).toMatch(/CONTEÚDO do artefato[\s\S]*NÃO entram jargão interno/);
    // D-027: layout profissional automático + bloco ```grafico (só em PDF).
    expect(sp).toMatch(/layout profissional automático/);
    expect(sp).toMatch(/GRÁFICOS \(apenas em artefatos PDF/);
    expect(sp).toMatch(/"tipo":"barras"\|"linhas"\|"pizza"/);
    expect(sp).toMatch(/máx\. 8 fatias/);
  });

  it('montarSystemPrompt injeta as instruções do tenant SUBORDINADAS às regras (D-020)', () => {
    const sp = montarSystemPrompt('Responda em tom formal. Faturamento é prioritário.');
    expect(sp).toContain('INSTRUÇÕES DO ADMINISTRADOR DO TENANT');
    expect(sp).toContain('Responda em tom formal. Faturamento é prioritário.');
    // Precedência explícita: as regras da plataforma prevalecem sobre o tenant.
    expect(sp).toContain('as regras da plataforma PREVALECEM');
    // As instruções vêm DEPOIS das regras da plataforma (posição = subordinação).
    expect(sp.indexOf('PROTOCOLO OBRIGATÓRIO')).toBeLessThan(
      sp.indexOf('INSTRUÇÕES DO ADMINISTRADOR DO TENANT'),
    );
    // Sem instruções (null/vazia/só espaços), a seção NÃO existe.
    expect(montarSystemPrompt()).not.toContain('INSTRUÇÕES DO ADMINISTRADOR DO TENANT');
    expect(montarSystemPrompt('   ')).not.toContain('INSTRUÇÕES DO ADMINISTRADOR DO TENANT');
  });

  it('normaliza respostaAoCliente do structured_output (D-015)', async () => {
    const msg: MensagemSdk = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      duration_ms: 10,
      usage: { input_tokens: 5, output_tokens: 2 },
      structured_output: {
        compreendido: true,
        confianca: 0.9,
        respostaAoCliente: 'Entendi seu pedido e já estamos cuidando disso.',
        diagnostico: 'causa X',
      },
    };
    const r = mapearResultado(msg, Date.now());
    expect(r.respostaAoCliente).toBe('Entendi seu pedido e já estamos cuidando disso.');
    // respostaAoCliente vazia/ausente → null.
    const semResposta = mapearResultado(
      { type: 'result', subtype: 'success', structured_output: { compreendido: true } },
      Date.now(),
    );
    expect(semResposta.respostaAoCliente).toBeNull();
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

// ---------------------------------------------------------------------------
// D-014 — fronteira das ferramentas NATIVAS (Read/Grep/Glob) via canUseTool
// ---------------------------------------------------------------------------

describe('ClaudeAgentProvider — canUseTool / avaliarPermissaoNativa (D-014)', () => {
  const CWD = join(process.cwd(), 'checkout-fake'); // base absoluta do "checkout"

  it('só Read/Grep/Glob são as nativas habilitadas (Bash/Write/Edit fora)', () => {
    expect([...FERRAMENTAS_NATIVAS].sort()).toEqual(['Glob', 'Grep', 'Read']);
    for (const proibida of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']) {
      expect(avaliarPermissaoNativa(proibida, {}, CWD).permitido).toBe(false);
    }
  });

  it('Read ACEITA caminho DENTRO do checkout (relativo e absoluto)', () => {
    expect(avaliarPermissaoNativa('Read', { file_path: 'src/regua.ts' }, CWD).permitido).toBe(true);
    expect(
      avaliarPermissaoNativa('Read', { file_path: join(CWD, 'src/regua.ts') }, CWD).permitido,
    ).toBe(true);
  });

  it('Read NEGA path traversal (..), caminho absoluto fora e sem file_path', () => {
    expect(avaliarPermissaoNativa('Read', { file_path: '../../etc/passwd' }, CWD).permitido).toBe(
      false,
    );
    expect(avaliarPermissaoNativa('Read', { file_path: '/etc/passwd' }, CWD).permitido).toBe(false);
    expect(
      avaliarPermissaoNativa('Read', { file_path: 'a/../../../fora.txt' }, CWD).permitido,
    ).toBe(false);
    expect(avaliarPermissaoNativa('Read', {}, CWD).permitido).toBe(false);
  });

  it('Grep: sem path usa o cwd (aceita); path/glob fora do checkout NEGA', () => {
    expect(avaliarPermissaoNativa('Grep', { pattern: 'regua' }, CWD).permitido).toBe(true);
    expect(avaliarPermissaoNativa('Grep', { pattern: 'x', path: 'src' }, CWD).permitido).toBe(true);
    expect(
      avaliarPermissaoNativa('Grep', { pattern: 'x', path: '../../outro' }, CWD).permitido,
    ).toBe(false);
    // `glob` é filtro de CAMINHO: um `..` no filtro é negado.
    expect(
      avaliarPermissaoNativa('Grep', { pattern: 'x', glob: '../**/*.ts' }, CWD).permitido,
    ).toBe(false);
  });

  it('Glob: pattern seguro aceita; pattern absoluto/.. ou path fora NEGA', () => {
    expect(avaliarPermissaoNativa('Glob', { pattern: '**/*.ts' }, CWD).permitido).toBe(true);
    expect(avaliarPermissaoNativa('Glob', { pattern: '../secret/*' }, CWD).permitido).toBe(false);
    expect(avaliarPermissaoNativa('Glob', { pattern: '/etc/*' }, CWD).permitido).toBe(false);
    expect(
      avaliarPermissaoNativa('Glob', { pattern: '**/*.ts', path: '../fora' }, CWD).permitido,
    ).toBe(false);
  });

  it('sem checkout (cwd null) as nativas são NEGADAS (fail-closed)', () => {
    expect(avaliarPermissaoNativa('Read', { file_path: 'x' }, null).permitido).toBe(false);
    expect(avaliarPermissaoNativa('Grep', { pattern: 'x' }, null).permitido).toBe(false);
  });

  it('canUseTool: MCP permitido (sem auditar); Read dentro permite+audita; fora nega+audita', async () => {
    const acoes: Array<{ f: string; a: unknown }> = [];
    const auditar = (f: string, a: unknown): void => void acoes.push({ f, a });
    const canUseTool = criarCanUseTool(CWD, auditar);

    // MCP: permitido, e NÃO audita aqui (o próprio handle MCP já se audita).
    const mcp = await canUseTool('mcp__triagem__repo_buscar', { consulta: 'x' });
    expect(mcp.behavior).toBe('allow');

    // Read dentro: permite + registra na trilha `acoes`.
    const dentro = await canUseTool('Read', { file_path: 'src/regua.ts' });
    expect(dentro.behavior).toBe('allow');

    // Read fora: NEGA (com mensagem) + registra a tentativa negada.
    const fora = await canUseTool('Read', { file_path: '../../etc/passwd' });
    expect(fora.behavior).toBe('deny');
    if (fora.behavior === 'deny') expect(fora.message).toMatch(/fora do checkout/);

    expect(acoes.map((x) => x.f)).toEqual(['Read', 'Read']); // MCP não auditado aqui
    expect((acoes[1]!.a as { _negado?: string })._negado).toMatch(/fora do checkout/);
  });

  it('canUseTool: ferramenta não permitida (Bash) é negada', async () => {
    const canUseTool = criarCanUseTool(CWD);
    const r = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(r.behavior).toBe('deny');
  });
});
