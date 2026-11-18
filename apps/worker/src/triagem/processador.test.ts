import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { AIProvider, AIProviderInput, AIProviderResult } from '@chamados/shared';
import type { JobTriagem } from '@chamados/db';
import { ErroTriagemCancelada } from '../ia/erros';

/**
 * D-041 — o PIPELINE da triagem diante do silêncio da IA durante a execução, sem
 * infra: banco (EntityManager), Redis, contexto, aplicador e lock são FAKES; o
 * que se prova é a orquestração do processador:
 *   - silenciado antes da Tx2 (só a flag no banco — sinal Redis perdido) → NADA
 *     é aplicado, `ExecucaoIA` cancelada, sem escalonamento por falha;
 *   - sinal Redis durante o provider → abort pelo signal, cancelada;
 *   - cancelamento devolve resultado (não lança) → BullMQ não re-tenta;
 *   - sinal obsoleto (anterior ao início) é descartado e não cancela;
 *   - silêncio antes do push da resolução → nada publicado;
 *   - a compensação de falha final não escala chamado silenciado.
 */

const estado = {
  silenciadaNoBanco: false,
};

const em = {
  findOne: vi.fn(async (_schema: unknown, opts?: { where?: { id?: string } }) =>
    opts?.where?.id
      ? { id: opts.where.id, status: 'em_triagem', ia_silenciada: false }
      : { id: 'u-ia', papel: 'agente_ia' },
  ),
  query: vi.fn(async (sql: string) =>
    sql.includes('ia_silenciada') ? [{ ia_silenciada: estado.silenciadaNoBanco }] : [],
  ),
};

const db = vi.hoisted(() => ({
  criarExecucao: vi.fn(async () => 'exec-1'),
  marcarExecutando: vi.fn(async () => {}),
  concluirExecucao: vi.fn(async () => {}),
  falharExecucao: vi.fn(async () => {}),
  cancelarExecucao: vi.fn(async () => {}),
  gravarEvento: vi.fn(async () => {}),
  transicionarStatus: vi.fn(async () => ({ ok: true })),
  flushNotif: vi.fn(async () => {}),
}));

vi.mock('@chamados/db', async (orig) => {
  const real = await orig<typeof import('@chamados/db')>();
  return {
    ...real,
    runInTenantContext: vi.fn(
      async (_ds: unknown, _t: string, fn: (e: unknown) => Promise<unknown>) => fn(em),
    ),
    existeConcluidaParaMensagem: vi.fn(async () => false),
    criarExecucao: db.criarExecucao,
    marcarExecutando: db.marcarExecutando,
    concluirExecucao: db.concluirExecucao,
    falharExecucao: db.falharExecucao,
    cancelarExecucao: db.cancelarExecucao,
    gravarEvento: db.gravarEvento,
    transicionarStatus: db.transicionarStatus,
    carregarTenant: vi.fn(async () => ({})),
    DespachanteNotificacoes: class {
      publicar(): void {}
      flush = db.flushNotif;
    },
  };
});

const apl = vi.hoisted(() => ({
  aplicarResultado: vi.fn(async () => {}),
  escalarParaHumano: vi.fn(async () => {}),
  encerrarTriagemCancelada: vi.fn(async () => {}),
}));
vi.mock('./aplicador', () => apl);

vi.mock('../lock-tenant', () => ({
  adquirirLockComEspera: vi.fn(async () => 'tok'),
  manterLockVivo: vi.fn(() => () => {}),
  liberarLockTenant: vi.fn(async () => {}),
}));

const res = vi.hoisted(() => ({
  gate: false,
  executarResolucao: vi.fn(),
}));
vi.mock('./resolucao', () => ({
  deveTentarResolver: () => res.gate,
  executarResolucao: res.executarResolucao,
}));

let ctxFake: ReturnType<typeof criarCtx>;
vi.mock('./contexto', () => ({ montarInput: vi.fn(async () => ctxFake) }));

function criarCtx() {
  const input = {
    contexto: {
      titulo: 'Erro ao salvar',
      descricao: 'desc',
      naturezaDeclarada: 'problema',
      prioridadeDeclarada: 'media',
      solicitante: { nome: 'Ana', papel: 'cliente' },
      timeline: [],
      sistemaAlvo: null,
    },
    ferramentas: {},
    limites: { timeoutMs: 60_000, budgetUsd: 1, maxTurnos: 5 },
  } as unknown as AIProviderInput;
  return {
    input,
    sincronizar: vi.fn(async () => {}),
    prepararResolucao: vi.fn(async () => {}),
    copiaResolucao: vi.fn(() => ({ dir: '/tmp/copia' })),
    checkout: vi.fn(() => null),
    artefatos: vi.fn(() => []),
    encerrar: vi.fn(async () => {}),
    resolucao: {
      tenantHabilitado: true,
      repo: { repoUrl: 'https://github.com/o/r.git', credencial: 'x', branchPadrao: 'main' },
      numeroChamado: 7,
    },
    sistemaAlvoId: null,
    carregarImagens: vi.fn(async () => {}),
    refsImagens: 0,
  };
}

const { processarTriagem } = await import('./processador');
const { compensarFalhaFinal } = await import('../filas/triagem-ia');

function resultadoOk(extra: Partial<AIProviderResult> = {}): AIProviderResult {
  return {
    compreendido: true,
    confianca: 'alta',
    perguntasAoCliente: null,
    respostaAoCliente: 'Olá! Estamos verificando.',
    complexidade: 'facil',
    naturezaAjustada: null,
    prioridadeSugerida: null,
    diagnostico: 'diag',
    spec: null,
    tentativaResolucao: null,
    telemetria: { custoUsd: 0.5, duracaoMs: 1000, tokensEntrada: 900, tokensSaida: 90 },
    ...extra,
  } as AIProviderResult;
}

function redisFake(sinalInicial = false) {
  let sinal = sinalInicial;
  const r = {
    exists: vi.fn(async () => (sinal ? 1 : 0)),
    del: vi.fn(async () => {
      sinal = false;
      return 1;
    }),
    set: vi.fn(async () => 'OK'),
  };
  return { redis: r as unknown as Redis, r, ligar: () => (sinal = true) };
}

function deps(redis: Redis, provider: AIProvider) {
  return {
    ds: {} as DataSource,
    redis,
    provider,
    limites: { timeoutMs: 60_000, budgetUsd: 1, maxTurnos: 5 },
    lock: { ttlMs: 90_000, esperaMaxMs: 0, intervaloMs: 10, renovacaoMs: 30_000 },
    log: () => {},
    cancelamentoPollMs: 5,
  } as Parameters<typeof processarTriagem>[1];
}

function provider(exec: (input: AIProviderInput) => Promise<AIProviderResult>): AIProvider {
  return {
    nome: 'fake',
    modelo: 'fake-1',
    executarTriagem: vi.fn(exec),
    mapearSistema: vi.fn(),
  };
}

const JOB: JobTriagem = {
  tenantId: 't-1',
  chamadoId: '11111111-1111-4111-8111-111111111111',
  ultimaMensagemId: 'm-1',
  gatilho: 'resposta_cliente' as JobTriagem['gatilho'],
};

beforeEach(() => {
  vi.clearAllMocks();
  estado.silenciadaNoBanco = false;
  res.gate = false;
  ctxFake = criarCtx();
});

describe('processarTriagem — cancelamento por silêncio da IA (D-041)', () => {
  it('sem silêncio: aplica e conclui (linha de base)', async () => {
    const { redis } = redisFake();
    const r = await processarTriagem(
      JOB,
      deps(
        redis,
        provider(async () => resultadoOk()),
      ),
    );
    expect(r).toEqual({ status: 'concluido', execucaoId: 'exec-1' });
    expect(apl.aplicarResultado).toHaveBeenCalledTimes(1);
    expect(db.concluirExecucao).toHaveBeenCalledTimes(1);
    expect(db.cancelarExecucao).not.toHaveBeenCalled();
  });

  it('silenciado ANTES da Tx2 (só a flag no banco — sinal Redis perdido): NADA é aplicado', async () => {
    const { redis } = redisFake();
    const prov = provider(async () => {
      estado.silenciadaNoBanco = true; // silêncio commitado enquanto o provider rodava
      return resultadoOk();
    });
    const r = await processarTriagem(JOB, deps(redis, prov));

    expect(r).toEqual({ status: 'cancelado', execucaoId: 'exec-1', motivo: 'ia_silenciada' });
    // Nenhum efeito: sem aplicação (mensagem/nota/transição/classificação), sem conclusão,
    // sem notificação, sem falha/escalonamento por erro.
    expect(apl.aplicarResultado).not.toHaveBeenCalled();
    expect(db.concluirExecucao).not.toHaveBeenCalled();
    expect(db.flushNotif).not.toHaveBeenCalled();
    expect(db.falharExecucao).not.toHaveBeenCalled();
    expect(apl.escalarParaHumano).not.toHaveBeenCalled();
    // Encerramento coerente: ExecucaoIA cancelada com a telemetria da resposta descartada.
    expect(db.cancelarExecucao).toHaveBeenCalledWith(
      em,
      'exec-1',
      'ia_silenciada',
      expect.objectContaining({
        telemetriaParcial: expect.objectContaining({ tokensEntrada: 900 }),
      }),
    );
    expect(apl.encerrarTriagemCancelada).toHaveBeenCalledWith(
      em,
      expect.objectContaining({ chamadoId: JOB.chamadoId, execucaoId: 'exec-1' }),
      expect.anything(),
    );
  });

  it('sinal Redis DURANTE o provider: o signal aborta a chamada e a execução é cancelada', async () => {
    const { redis, ligar } = redisFake();
    let sinalRecebido: AbortSignal | undefined;
    const prov = provider(async (input) => {
      sinalRecebido = input.sinalCancelamento;
      estado.silenciadaNoBanco = true; // o silêncio commita ANTES do sinal
      ligar(); // o web silenciou: chave gravada
      await new Promise<void>((_ok, rej) =>
        input.sinalCancelamento!.addEventListener('abort', () =>
          rej(new ErroTriagemCancelada({ tokensEntrada: 321 })),
        ),
      );
      return resultadoOk();
    });
    const r = await processarTriagem(JOB, deps(redis, prov));

    expect(sinalRecebido).toBeDefined();
    expect(sinalRecebido!.aborted).toBe(true);
    expect(r.status).toBe('cancelado');
    expect(apl.aplicarResultado).not.toHaveBeenCalled();
    expect(apl.escalarParaHumano).not.toHaveBeenCalled();
    expect(db.cancelarExecucao).toHaveBeenCalledWith(
      em,
      'exec-1',
      'ia_silenciada',
      expect.objectContaining({ telemetriaParcial: { tokensEntrada: 321 } }),
    );
  });

  it('cancelamento RESOLVE (não lança): o BullMQ não re-tenta nem dispara a compensação', async () => {
    const { redis } = redisFake();
    const prov = provider(async () => {
      throw new ErroTriagemCancelada();
    });
    await expect(processarTriagem(JOB, deps(redis, prov))).resolves.toMatchObject({
      status: 'cancelado',
    });
  });

  it('silêncio durante o git sync: nem chama o provider', async () => {
    const { redis, ligar } = redisFake();
    ctxFake.sincronizar.mockImplementation(async () => {
      estado.silenciadaNoBanco = true; // o silêncio commita ANTES do sinal
      ligar();
    });
    const prov = provider(async () => resultadoOk());
    const r = await processarTriagem(JOB, deps(redis, prov));
    expect(r.status).toBe('cancelado');
    expect(prov.executarTriagem).not.toHaveBeenCalled();
    expect(apl.aplicarResultado).not.toHaveBeenCalled();
  });

  it('sinal OBSOLETO (anterior ao início da execução) é descartado e não cancela', async () => {
    const { redis, r: raw } = redisFake(true);
    const r = await processarTriagem(
      JOB,
      deps(
        redis,
        provider(async () => resultadoOk()),
      ),
    );
    expect(raw.del).toHaveBeenCalledWith(`chamados:triagem:cancelar:${JOB.chamadoId}`);
    expect(r.status).toBe('concluido');
  });

  it('sinal ATRASADO durante a execução, com a IA já reativada no banco, NÃO cancela', async () => {
    const { redis, ligar } = redisFake();
    const r = await processarTriagem(
      JOB,
      deps(
        redis,
        provider(async () => {
          ligar(); // flush antigo de um silêncio já desfeito: chave sem flag no banco
          return resultadoOk();
        }),
      ),
    );
    expect(r.status).toBe('concluido');
    expect(apl.encerrarTriagemCancelada).not.toHaveBeenCalled();
  });

  it('falha REAL do provider com a IA já silenciada vira cancelamento — sem ia_falhou duplicado', async () => {
    const { redis } = redisFake();
    const prov = provider(async () => {
      estado.silenciadaNoBanco = true;
      throw new Error('rede caiu');
    });
    const r = await processarTriagem(JOB, deps(redis, prov));
    expect(r.status).toBe('cancelado');
    expect(db.falharExecucao).not.toHaveBeenCalled();
    expect(apl.escalarParaHumano).not.toHaveBeenCalled();
    expect(apl.encerrarTriagemCancelada).toHaveBeenCalledTimes(1);
  });

  it('falha REAL sem silêncio continua escalando (comportamento D-016 intacto)', async () => {
    const { redis } = redisFake();
    const prov = provider(async () => {
      throw new Error('rede caiu');
    });
    const r = await processarTriagem(JOB, deps(redis, prov));
    expect(r).toEqual({ status: 'falhou', execucaoId: 'exec-1', erro: 'rede caiu' });
    expect(apl.escalarParaHumano).toHaveBeenCalledTimes(1);
    expect(db.cancelarExecucao).not.toHaveBeenCalled();
  });

  it('silêncio antes do PUSH da resolução: deveCancelar interrompe e nada é publicado/aplicado', async () => {
    const { redis, ligar } = redisFake();
    res.gate = true;
    res.executarResolucao.mockImplementation(
      async (_e: unknown, d: { deveCancelar?: () => Promise<boolean> }) => {
        estado.silenciadaNoBanco = true; // o silêncio commita ANTES do sinal
        ligar(); // silêncio chegou durante o commit local
        if (await d.deveCancelar?.()) throw new ErroTriagemCancelada();
        throw new Error('não deveria chegar ao push');
      },
    );
    const prov = provider(async () =>
      resultadoOk({ tentativaResolucao: { resumo: 'fix', arquivosAlterados: ['a.ts'] } }),
    );
    const r = await processarTriagem(JOB, deps(redis, prov));
    expect(res.executarResolucao).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('cancelado');
    expect(apl.aplicarResultado).not.toHaveBeenCalled();
    expect(apl.encerrarTriagemCancelada).toHaveBeenCalledWith(
      em,
      expect.objectContaining({ resolucaoPublicada: null }),
      expect.anything(),
    );
  });

  it('PR já aberto quando o silêncio chega antes da Tx2: nada aplicado, mas a nota registra o PR', async () => {
    const { redis } = redisFake();
    res.gate = true;
    res.executarResolucao.mockImplementation(async () => {
      estado.silenciadaNoBanco = true; // silêncio depois do push/PR
      return {
        resumo: 'fix',
        arquivosAlterados: ['a.ts'],
        branch: 'ia/chamado-7-x',
        prUrl: 'https://github.com/o/r/pull/1',
        situacao: 'pr_aberto',
      };
    });
    const prov = provider(async () =>
      resultadoOk({ tentativaResolucao: { resumo: 'fix', arquivosAlterados: ['a.ts'] } }),
    );
    const r = await processarTriagem(JOB, deps(redis, prov));
    expect(r.status).toBe('cancelado');
    expect(apl.aplicarResultado).not.toHaveBeenCalled();
    expect(apl.encerrarTriagemCancelada).toHaveBeenCalledWith(
      em,
      expect.objectContaining({
        resolucaoPublicada: { branch: 'ia/chamado-7-x', prUrl: 'https://github.com/o/r/pull/1' },
      }),
      expect.anything(),
    );
  });
});

describe('compensarFalhaFinal — chamado silenciado (D-041)', () => {
  const depsComp = {
    ds: {} as DataSource,
    provider: provider(async () => resultadoOk()),
    log: () => {},
  };

  it('IA silenciada: não cria ExecucaoIA falha nem escala (sem duplicidade)', async () => {
    estado.silenciadaNoBanco = true;
    await compensarFalhaFinal(JOB, 'lock_tenant_indisponivel', depsComp);
    expect(db.criarExecucao).not.toHaveBeenCalled();
    expect(apl.escalarParaHumano).not.toHaveBeenCalled();
  });

  it('IA ativa: compensa como antes', async () => {
    await compensarFalhaFinal(JOB, 'lock_tenant_indisponivel', depsComp);
    expect(db.criarExecucao).toHaveBeenCalledTimes(1);
    expect(db.falharExecucao).toHaveBeenCalledTimes(1);
    expect(apl.escalarParaHumano).toHaveBeenCalledTimes(1);
  });
});
