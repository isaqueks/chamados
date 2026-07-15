/**
 * Smoke da infraestrutura de triagem de IA (M6 — specs/05, specs/01 §3.5).
 *
 * IA_PROVIDER=fake; processa a fila `triagem-ia` INLINE (chama o processador
 * direto sobre os jobs enfileirados). Prova:
 *   1. criar chamado → job enfileirado → ExecucaoIA CONCLUÍDA com resultado fake
 *      + telemetria + evento `ia_iniciou` + trilha de ações (stub de ferramenta);
 *   2. DEDUP: 2 enfileiramentos do mesmo par (chamado+msg) → 1 job → 1 execução;
 *      idempotência: reprocessar o mesmo job → ignorado (não cria 2ª execução);
 *   3. DEBOUNCE substituível: nova mensagem remove o job pendente anterior;
 *   4. falha do provider ([[falhar]]) → ExecucaoIA `falhou` + evento `ia_falhou`;
 *   5. LOCK por tenant: 2º acquire falha; processador sem lock devolve à fila;
 *   6. RLS de `execucao_ia`: tenant B não enxerga execução do tenant A;
 *   7. CLIENTE não vê execuções (autorização nega — lista vazia).
 *
 * Requer Postgres + Redis de pé. Sai 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();
process.env.IA_PROVIDER = 'fake';
process.env.TRIAGEM_DEBOUNCE_S = '0'; // enfileira sem espera (processa inline)

const {
  criarAppDataSource,
  criarAdminDataSource,
  runInTenantContext,
  provisionarTenant,
  criarUsuarioAtivoComSenha,
  criarChamado,
  criarMensagem,
  transicionarStatus,
  atorSistema,
  DespachanteFila,
  DespachanteNotificacoes,
  filaTriagem,
  enfileirarTriagem,
  jobIdTriagem,
  prefixoJobChamado,
  listarExecucoesDoChamado,
  existeConcluidaParaMensagem,
  ExecucaoIASchema,
  ChamadoSchema,
} = await import('@chamados/db');
const {
  Papel,
  StatusTenant,
  StatusChamado,
  Natureza,
  Complexidade,
  VisibilidadeMensagem,
  StatusExecucaoIA,
} = await import('@chamados/shared');
const { processarTriagem } = await import('../triagem/processador');
const { resolverProvider } = await import('../ia/resolver-provider');
const { adquirirLockTenant, liberarLockTenant } = await import('../lock-tenant');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const log = (msg: string, extra?: Record<string, unknown>): void => {
  void msg;
  void extra;
};

const LIMITES = { timeoutMs: 30_000, budgetUsd: 1, maxTurnos: 5 };
const LOCK = { ttlMs: 60_000, esperaMaxMs: 0, intervaloMs: 100 };

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
    maxRetriesPerRequest: null,
  });
  console.log('[smoke-triagem] conectado (role da app, sem bypass) + Redis.');

  const fila = filaTriagem();
  await fila.obliterate({ force: true }).catch(() => {});

  const provider = resolverProvider({ provider: 'fake', modelo: 'ignorado-no-fake' });
  ok(provider.nome === 'fake', 'resolverProvider(fake) devolve o FakeProvider');
  const deps = { ds, redis, provider, limites: LIMITES, lock: LOCK, log };

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  /** Processa TODOS os jobs prontos da fila via o processador (inline). */
  async function drenar(): Promise<Array<{ status: string }>> {
    const jobs = await fila.getJobs(['wait', 'delayed', 'paused', 'prioritized']);
    const res: Array<{ status: string }> = [];
    for (const j of jobs) {
      const r = await processarTriagem(j.data, deps);
      res.push(r);
      await j.remove().catch(() => {});
    }
    return res;
  }

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-ia-a-${sufixo}`,
      nome: 'IA A',
      nomeExibicao: 'IA A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-ia-b-${sufixo}`,
      nome: 'IA B',
      nomeExibicao: 'IA B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    const { cliente, operador } = await runInTenantContext(ds, tenantA, async (em) => {
      const cliente = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Cliente A',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const operador = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Operador A',
        papel: Papel.operador,
        senha: 'Dev@12345',
      });
      return { cliente, operador };
    });
    const clienteB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `cli.${sufixo}@b.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      }),
    );
    const atorCli = { id: cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorOp = { id: operador, tenant_id: tenantA, papel: Papel.operador };
    const atorCliB = { id: clienteB, tenant_id: tenantB, papel: Papel.cliente };

    // 1) Criar chamado → gatilho enfileira → ExecucaoIA concluída ------------
    const chamadoId = await runInTenantContext(ds, tenantA, async (em) => {
      const desp = new DespachanteFila(log);
      const r = await criarChamado(
        em,
        atorCli,
        {
          titulo: 'Erro 500 ao salvar pedido [[complexidade:facil]]',
          descricao: 'Ao finalizar o pedido aparece erro 500.',
          natureza: Natureza.problema,
        },
        { despachante: desp },
      );
      if (!r.ok) throw new Error(`falha ao criar chamado: ${r.motivo}`);
      // flush pós-"commit" (dentro do smoke o commit fecha ao sair do runInTenantContext;
      // para o teste inline enfileiramos aqui — o processador só lê dados já visíveis).
      await desp.flush();
      return r.id;
    });

    let jobs = await fila.getJobs(['wait', 'delayed', 'paused', 'prioritized']);
    ok(jobs.length === 1, 'criar chamado enfileirou 1 job de triagem (seam do despachante)');
    ok(jobs[0]?.id === jobIdTriagem(chamadoId, null), 'jobId é determinístico (chamado + inicial)');

    const r1 = await drenar();
    ok(r1.length === 1 && r1[0]?.status === 'concluido', 'job processado → concluido');

    await runInTenantContext(ds, tenantA, async (em) => {
      const execs = await listarExecucoesDoChamado(em, atorOp, chamadoId);
      ok(execs.length === 1, 'existe 1 ExecucaoIA para o chamado');
      const e = execs[0]!;
      ok(e.status === StatusExecucaoIA.concluido, 'ExecucaoIA está concluida');
      ok(e.provider === 'fake', 'provider gravado = fake');
      ok(e.gatilho === 'chamado_criado', 'gatilho = chamado_criado');
      ok(
        e.custo_usd !== null && e.tokens_entrada !== null && e.duracao_ms !== null,
        'telemetria gravada',
      );
      ok(e.resultado?.compreendido === true, 'resultado bruto do provider gravado (compreendido)');

      const eventos: Array<{ tipo: string }> = await em.query(
        `SELECT tipo FROM evento_chamado WHERE chamado_id = $1`,
        [chamadoId],
      );
      const tipos = new Set(eventos.map((x) => x.tipo));
      ok(tipos.has('ia_iniciou'), 'evento ia_iniciou registrado');

      const linhaAcoes: Array<{ acoes: unknown[] }> = await em.query(
        `SELECT acoes FROM execucao_ia WHERE id = $1`,
        [e.id],
      );
      ok(
        Array.isArray(linhaAcoes[0]?.acoes) && linhaAcoes[0]!.acoes.length >= 1,
        'trilha de ações tem ≥1 chamada de ferramenta real (repo_buscar)',
      );
    });

    // 7) Cliente NÃO vê execuções -------------------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const comoCliente = await listarExecucoesDoChamado(em, atorCli, chamadoId);
      ok(comoCliente.length === 0, 'cliente NÃO vê ExecucaoIA (autorização nega)');
    });

    // 6) RLS: tenant B não enxerga execução do tenant A ---------------------
    await runInTenantContext(ds, tenantB, async (em) => {
      const linhas = await em.find(ExecucaoIASchema, { where: { chamado_id: chamadoId } });
      ok(linhas.length === 0, 'tenant B não enxerga execucao_ia do tenant A (RLS)');
      const daFuncao = await listarExecucoesDoChamado(em, atorCliB, chamadoId);
      ok(daFuncao.length === 0, 'tenant B (cliente) lista vazio p/ chamado do tenant A');
    });

    // 2) DEDUP + idempotência ------------------------------------------------
    const chamado2 = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Botão de exportar não responde',
        descricao: 'Nada acontece ao clicar em exportar.',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado 2');
      return r.id;
    });
    await enfileirarTriagem({
      tenantId: tenantA,
      chamadoId: chamado2,
      ultimaMensagemId: null,
      gatilho: 'chamado_criado',
    });
    await enfileirarTriagem({
      tenantId: tenantA,
      chamadoId: chamado2,
      ultimaMensagemId: null,
      gatilho: 'chamado_criado',
    });
    jobs = await fila.getJobs(['wait', 'delayed', 'paused', 'prioritized']);
    ok(
      jobs.filter((j) => typeof j.id === 'string' && j.id.startsWith(prefixoJobChamado(chamado2)))
        .length === 1,
      'DEDUP: 2 enfileiramentos do mesmo par → 1 job (jobId determinístico)',
    );
    const r2 = await drenar();
    ok(
      r2.some((x) => x.status === 'concluido'),
      'job do chamado 2 processado → concluido',
    );
    // Reprocessar o MESMO job → idempotente (não cria 2ª execução).
    const rIdem = await processarTriagem(
      { tenantId: tenantA, chamadoId: chamado2, ultimaMensagemId: null, gatilho: 'chamado_criado' },
      deps,
    );
    ok(rIdem.status === 'ignorado', 'reprocessar par já concluído → ignorado (idempotência)');
    await runInTenantContext(ds, tenantA, async (em) => {
      ok(
        await existeConcluidaParaMensagem(em, chamado2, null),
        'existeConcluidaParaMensagem confirma execução do par',
      );
      const execs = await listarExecucoesDoChamado(em, atorOp, chamado2);
      ok(execs.length === 1, 'apenas 1 ExecucaoIA para o chamado 2 (dedup + idempotência)');
    });

    // 3) DEBOUNCE substituível ----------------------------------------------
    const chamado3 = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Relatório mensal',
        descricao: 'Detalhe A.',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado 3');
      return r.id;
    });
    // Enfileira p/ "mensagem 1" e depois p/ "mensagem 2" (delay grande = fica pendente).
    await enfileirarTriagem(
      {
        tenantId: tenantA,
        chamadoId: chamado3,
        ultimaMensagemId: 'msg-1',
        gatilho: 'resposta_cliente',
      },
      { delayMs: 60_000 },
    );
    await enfileirarTriagem(
      {
        tenantId: tenantA,
        chamadoId: chamado3,
        ultimaMensagemId: 'msg-2',
        gatilho: 'resposta_cliente',
      },
      { delayMs: 60_000 },
    );
    const pend = (await fila.getJobs(['delayed', 'wait', 'paused', 'prioritized'])).filter(
      (j) => typeof j.id === 'string' && j.id.startsWith(prefixoJobChamado(chamado3)),
    );
    ok(pend.length === 1, 'DEBOUNCE: novo enfileiramento substituiu o job pendente (1 pendente)');
    ok(
      pend[0]?.id === jobIdTriagem(chamado3, 'msg-2'),
      'o job pendente é o da ÚLTIMA mensagem (msg-2)',
    );
    for (const j of pend) await j.remove().catch(() => {});

    // 4) Falha do provider → falhou + ia_falhou -----------------------------
    const chamadoFalha = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Chamado que força falha [[falhar]]',
        descricao: 'Deve falhar na triagem.',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado de falha');
      return r.id;
    });
    const rFalha = await processarTriagem(
      {
        tenantId: tenantA,
        chamadoId: chamadoFalha,
        ultimaMensagemId: null,
        gatilho: 'chamado_criado',
      },
      deps,
    );
    ok(rFalha.status === 'falhou', 'provider [[falhar]] → processamento falhou');
    await runInTenantContext(ds, tenantA, async (em) => {
      const execs = await listarExecucoesDoChamado(em, atorOp, chamadoFalha);
      ok(execs[0]?.status === StatusExecucaoIA.falhou, 'ExecucaoIA status = falhou');
      ok(!!execs[0]?.erro, 'campo erro preenchido');
      const eventos: Array<{ tipo: string }> = await em.query(
        `SELECT tipo FROM evento_chamado WHERE chamado_id = $1 AND tipo = 'ia_falhou'`,
        [chamadoFalha],
      );
      ok(eventos.length === 1, 'evento ia_falhou registrado');
    });

    // Timeout/budget viram falhou com erro específico -----------------------
    const chamadoBudget = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Estoura budget [[budget]]',
        descricao: 'x',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado budget');
      return r.id;
    });
    await processarTriagem(
      {
        tenantId: tenantA,
        chamadoId: chamadoBudget,
        ultimaMensagemId: null,
        gatilho: 'chamado_criado',
      },
      deps,
    );
    await runInTenantContext(ds, tenantA, async (em) => {
      const execs = await listarExecucoesDoChamado(em, atorOp, chamadoBudget);
      ok(
        execs[0]?.status === StatusExecucaoIA.falhou && execs[0]?.erro === 'budget_excedido',
        'budget excedido → status falhou + erro="budget_excedido" (specs/05 §8)',
      );
    });

    // 5) LOCK por tenant -----------------------------------------------------
    const t1 = await adquirirLockTenant(redis, tenantA, 5_000);
    ok(t1 !== null, 'lock por tenant adquirido');
    const t2 = await adquirirLockTenant(redis, tenantA, 5_000);
    ok(t2 === null, '2º acquire do MESMO tenant é negado (1 execução simultânea)');
    // Com o lock preso e esperaMax=0, o processador devolve o job à fila (throw).
    const chamadoLock = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Chamado com lock preso',
        descricao: 'x',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado lock');
      return r.id;
    });
    let devolveu = false;
    try {
      await processarTriagem(
        {
          tenantId: tenantA,
          chamadoId: chamadoLock,
          ultimaMensagemId: null,
          gatilho: 'chamado_criado',
        },
        deps,
      );
    } catch (e) {
      devolveu = (e as Error).message === 'lock_tenant_indisponivel';
    }
    ok(devolveu, 'processador sem lock devolve o job à fila (retry BullMQ)');
    await liberarLockTenant(redis, tenantA, t1!);
    const t3 = await adquirirLockTenant(redis, tenantA, 5_000);
    ok(t3 !== null, 'após liberar, o lock é readquirível');
    await liberarLockTenant(redis, tenantA, t3!);
    // Agora com o lock livre, o mesmo chamado processa normalmente.
    const rLock = await processarTriagem(
      {
        tenantId: tenantA,
        chamadoId: chamadoLock,
        ultimaMensagemId: null,
        gatilho: 'chamado_criado',
      },
      deps,
    );
    ok(rLock.status === 'concluido', 'com lock livre, o chamado processa → concluido');

    // Resposta do cliente re-enfileira (gatilho resposta_cliente) -----------
    const chamadoResp = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Chamado para responder',
        descricao: 'x',
        natureza: Natureza.problema,
      });
      if (!r.ok) throw new Error('falha ao criar chamado resp');
      await transicionarStatus(em, atorSistema(tenantA), r.id, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOp, r.id, StatusChamado.aguardando_cliente);
      return r.id;
    });
    await fila.obliterate({ force: true }).catch(() => {});
    await runInTenantContext(ds, tenantA, async (em) => {
      const desp = new DespachanteFila(log);
      const r = await criarMensagem(
        em,
        atorCli,
        {
          chamado_id: chamadoResp,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Segue a info.',
        },
        { despachante: desp },
      );
      if (!r.ok) throw new Error('falha ao responder');
      await desp.flush();
    });
    const jobsResp = (await fila.getJobs(['wait', 'delayed', 'paused', 'prioritized'])).filter(
      (j) => typeof j.id === 'string' && j.id.startsWith(prefixoJobChamado(chamadoResp)),
    );
    ok(
      jobsResp.length === 1,
      'resposta do cliente re-enfileirou a triagem (gatilho resposta_cliente)',
    );
    for (const j of jobsResp) {
      const r = await processarTriagem(j.data, deps);
      ok(r.status === 'concluido', 'triagem da resposta do cliente processou → concluido');
      await j.remove().catch(() => {});
    }

    // Sanidade: o M7 APLICA o resultado ao chamado (diagnóstico) -------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
      ok(
        ch?.complexidade === Complexidade.facil,
        'M7 aplica o resultado: complexidade classificada (facil)',
      );
      ok(
        ch?.status === StatusChamado.em_atendimento,
        'M7 aplica o resultado: chamado diagnosticado → em_atendimento',
      );
    });

    console.log('\n[smoke-triagem] RESULTADO: PASSOU — infra de triagem confirmada.');
  } finally {
    await fila.obliterate({ force: true }).catch(() => {});
    await DespachanteFila.fechar().catch(() => {});
    // O processador agora enfileira notificações (M9) pós-commit; fecha a conexão
    // do publicador da fila `notificacoes` para o processo do smoke não travar.
    await DespachanteNotificacoes.fechar().catch(() => {});
    redis.disconnect();

    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-triagem] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-triagem] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
