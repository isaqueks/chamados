/**
 * Smoke da manutenção do ciclo de vida + busca full-text (M10 — specs/04 §8, §10.4).
 *
 * Tenants DESCARTÁVEIS. Prova ponta a ponta:
 *   1. AUTO-FECHAMENTO (db): chamado `resolvido` VENCIDO (fechar_automaticamente_em
 *      no passado) é fechado (evento `chamado_fechado_auto`, `fechado_em` preenchido,
 *      prazo limpo) e notifica cliente + operador; um `resolvido` NÃO vencido NÃO
 *      é tocado.
 *   2. ORQUESTRAÇÃO + LOCK (worker): `executarManutencao` respeita o lock global
 *      (instância concorrente não varre) e, liberado, fecha o vencido varrendo os
 *      tenants ativos (via a função SECURITY DEFINER).
 *   3. REABERTURA: cliente reabre `resolvido` → `em_atendimento`, limpando o prazo,
 *      incrementando `reaberto_count` e notificando o operador atribuído.
 *   4. BUSCA FTS: stemming português (plural casa singular), ranking TÍTULO > CORPO,
 *      busca por número, e SEM vazamento entre tenants (RLS). Também no portal do
 *      cliente (listarChamados).
 *
 * Requer Postgres + Redis de pé. Sai 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const {
  criarAppDataSource,
  criarAdminDataSource,
  runInTenantContext,
  provisionarTenant,
  criarUsuarioAtivoComSenha,
  criarChamado,
  transicionarStatus,
  atribuirOperador,
  atorSistema,
  listarFilaChamados,
  listarChamados,
  fecharChamadosResolvidosVencidos,
  listarTenantsAtivos,
  ChamadoSchema,
  EventoChamadoSchema,
  filaNotificacoes,
} = await import('@chamados/db');
type JobNotificacao = import('@chamados/db').JobNotificacao;
type DespachanteColetor = import('@chamados/db').Despachante;

const { Papel, StatusTenant, StatusChamado, Natureza, Prioridade } =
  await import('@chamados/shared');
const { executarManutencao, CHAVE_LOCK_MANUTENCAO } = await import('../manutencao/processador');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const NO_PASSADO = new Date(Date.now() - 2 * 86_400_000);

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
    maxRetriesPerRequest: null,
  });
  console.log('[smoke-manutencao] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  /** Coleta os jobs de notificação traduzidos pelo seam de auditoria (sem enfileirar). */
  async function coletar(
    tenantId: string,
    fn: (
      em: Parameters<Parameters<typeof runInTenantContext>[2]>[0],
      hooks: unknown,
    ) => Promise<unknown>,
  ): Promise<JobNotificacao[]> {
    const jobs: JobNotificacao[] = [];
    const despachante = {
      capturaNotificacoes: true,
      publicar(ev: { tipo: string; job?: JobNotificacao }) {
        if (ev.tipo === 'notificacao' && ev.job) jobs.push(ev.job);
      },
    } as unknown as DespachanteColetor;
    await runInTenantContext(ds, tenantId, (em) => fn(em, { despachante }));
    return jobs;
  }

  /** Cria um chamado já em `resolvido` (novo→triagem→atendimento→resolvido). */
  async function criarResolvido(
    tenantId: string,
    ator: { id: string; tenant_id: string; papel: string },
    atorOp: { id: string; tenant_id: string; papel: string },
    dados: { titulo: string; descricao: string },
    opts: { atribuir?: boolean } = {},
  ): Promise<{ id: string; numero: string }> {
    return runInTenantContext(ds, tenantId, async (em) => {
      const r = await criarChamado(em, ator as never, {
        titulo: dados.titulo,
        descricao: dados.descricao,
        natureza: Natureza.problema,
        prioridade: Prioridade.media,
      });
      if (!r.ok) throw new Error(`criarChamado falhou: ${r.motivo}`);
      await transicionarStatus(em, atorSistema(tenantId), r.id, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOp as never, r.id, StatusChamado.em_atendimento);
      if (opts.atribuir) await atribuirOperador(em, atorOp as never, r.id, atorOp.id);
      await transicionarStatus(em, atorOp as never, r.id, StatusChamado.resolvido);
      return { id: r.id, numero: r.numero };
    });
  }

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-mn-a-${sufixo}`,
      nome: 'Manut A',
      nomeExibicao: 'Manut A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-mn-b-${sufixo}`,
      nome: 'Manut B',
      nomeExibicao: 'Manut B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    const uA = await runInTenantContext(ds, tenantA, async (em) => ({
      cliente: await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Carla Cliente',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      }),
      operador: await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Olga Operadora',
        papel: Papel.operador,
        senha: 'Dev@12345',
      }),
    }));
    const atorCli = { id: uA.cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorOp = { id: uA.operador, tenant_id: tenantA, papel: Papel.operador };

    const cliB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `cli.${sufixo}@b.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      }),
    );
    const atorCliB = { id: cliB, tenant_id: tenantB, papel: Papel.cliente };

    // =====================================================================
    // 1) AUTO-FECHAMENTO (db, determinístico via despachante coletor)
    // =====================================================================
    const chVencido = await criarResolvido(
      tenantA,
      atorCli,
      atorOp,
      { titulo: 'Lentidão no login corporativo', descricao: 'Demora ao autenticar.' },
      { atribuir: true },
    );
    const chNaoVencido = await criarResolvido(tenantA, atorCli, atorOp, {
      titulo: 'Ajuste de layout do rodapé',
      descricao: 'Alinhar o texto do rodapé.',
    });

    // Simula o decurso do prazo: o vencido teve o prazo movido para o passado.
    await runInTenantContext(ds, tenantA, (em) =>
      em.update(ChamadoSchema, { id: chVencido.id }, { fechar_automaticamente_em: NO_PASSADO }),
    );

    const jobsFech = await coletar(tenantA, (em, hooks) =>
      fecharChamadosResolvidosVencidos(em, tenantA, hooks as never),
    );

    const estados = await runInTenantContext(ds, tenantA, async (em) => ({
      venc: await em.findOne(ChamadoSchema, { where: { id: chVencido.id } }),
      nao: await em.findOne(ChamadoSchema, { where: { id: chNaoVencido.id } }),
    }));
    ok(estados.venc?.status === StatusChamado.fechado, 'chamado VENCIDO foi auto-fechado');
    ok(estados.venc?.fechado_em != null, 'fechado_em preenchido no auto-fechamento');
    ok(
      estados.venc?.fechar_automaticamente_em == null,
      'fechar_automaticamente_em limpo após fechar',
    );
    ok(
      estados.nao?.status === StatusChamado.resolvido,
      'chamado NÃO vencido permanece resolvido (não tocado)',
    );

    const evtFechado = await runInTenantContext(ds, tenantA, (em) =>
      em.findOne(EventoChamadoSchema, {
        where: { chamado_id: chVencido.id, tipo: 'chamado_fechado_auto' },
      }),
    );
    ok(!!evtFechado, 'evento chamado_fechado_auto registrado');
    ok(evtFechado?.ator_id === null, 'ator do auto-fechamento é o sistema (ator_id null)');

    const emailsFech = jobsFech.filter((j) => j.canal === 'email');
    ok(
      emailsFech.some((j) => j.destinatarioId === uA.cliente),
      'auto-fechamento NOTIFICA o cliente (e-mail)',
    );
    ok(
      emailsFech.some((j) => j.destinatarioId === uA.operador),
      'auto-fechamento notifica o operador atribuído',
    );
    ok(
      jobsFech.every((j) => j.evento === 'fechado'),
      'notificações de auto-fechamento têm evento notificável = fechado',
    );

    // =====================================================================
    // 2) ORQUESTRAÇÃO + LOCK (worker executarManutencao)
    // =====================================================================
    const chVencido2 = await criarResolvido(tenantA, atorCli, atorOp, {
      titulo: 'Botão de exportar não responde',
      descricao: 'Nada acontece ao exportar.',
    });
    await runInTenantContext(ds, tenantA, (em) =>
      em.update(ChamadoSchema, { id: chVencido2.id }, { fechar_automaticamente_em: NO_PASSADO }),
    );
    await filaNotificacoes().obliterate({ force: true });

    // Tenants ativos enumerados pela função SECURITY DEFINER (fora de contexto RLS).
    const ativos = await listarTenantsAtivos(ds);
    ok(
      ativos.includes(tenantA) && ativos.includes(tenantB),
      'listarTenantsAtivos enxerga os tenants ativos (SECURITY DEFINER)',
    );

    // Lock ocupado por outra instância → não varre.
    const tokenAlheio = randomUUID();
    await redis.set(CHAVE_LOCK_MANUTENCAO, tokenAlheio, 'PX', 30_000, 'NX');
    const resTravado = await executarManutencao({
      ds,
      redis,
      lockTtlMs: 30_000,
      execucaoOrfaMs: 3_600_000,
      triagemEncalhadaMs: 3_600_000,
      log: () => {},
    });
    ok(resTravado.executou === false, 'lock ocupado: instância concorrente NÃO varre');
    const aindaResolvido = await runInTenantContext(ds, tenantA, (em) =>
      em.findOne(ChamadoSchema, { where: { id: chVencido2.id } }),
    );
    ok(
      aindaResolvido?.status === StatusChamado.resolvido,
      'com lock ocupado, o vencido permanece resolvido',
    );

    // Libera o lock e varre de verdade.
    await redis.del(CHAVE_LOCK_MANUTENCAO);
    const resVarreu = await executarManutencao({
      ds,
      redis,
      lockTtlMs: 30_000,
      execucaoOrfaMs: 3_600_000,
      triagemEncalhadaMs: 3_600_000,
      log: () => {},
    });
    ok(resVarreu.executou === true, 'lock livre: a varredura executa');
    ok(resVarreu.fechados >= 1, 'a varredura fechou ao menos o chamado vencido');
    const fechado2 = await runInTenantContext(ds, tenantA, (em) =>
      em.findOne(ChamadoSchema, { where: { id: chVencido2.id } }),
    );
    ok(fechado2?.status === StatusChamado.fechado, 'executarManutencao fechou o vencido');

    // =====================================================================
    // 3) REABERTURA limpa o prazo, conta e notifica o operador
    // =====================================================================
    const chReabrir = await criarResolvido(
      tenantA,
      atorCli,
      atorOp,
      { titulo: 'Relatório com total incorreto', descricao: 'A soma final está errada.' },
      { atribuir: true },
    );
    const jobsReabre = await coletar(tenantA, (em, hooks) =>
      transicionarStatus(
        em,
        atorCli as never,
        chReabrir.id,
        StatusChamado.em_atendimento,
        {},
        hooks as never,
      ),
    );
    const reaberto = await runInTenantContext(ds, tenantA, (em) =>
      em.findOne(ChamadoSchema, { where: { id: chReabrir.id } }),
    );
    ok(reaberto?.status === StatusChamado.em_atendimento, 'reabertura volta para em_atendimento');
    ok(reaberto?.reaberto_count === 1, 'reaberto_count incrementado para 1');
    ok(reaberto?.resolvido_em == null, 'resolvido_em limpo na reabertura');
    ok(reaberto?.fechar_automaticamente_em == null, 'prazo de auto-fechamento cancelado');
    ok(
      jobsReabre.some((j) => j.canal === 'email' && j.destinatarioId === uA.operador),
      'reabertura NOTIFICA o operador atribuído',
    );

    // =====================================================================
    // 4) BUSCA FULL-TEXT (stemming, ranking, número, isolamento)
    // =====================================================================
    const chTitulo = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorCli as never, {
        titulo: 'Erro no faturamento mensal',
        descricao: 'Ao gerar a nota, aparece um erro genérico.',
        natureza: Natureza.problema,
      }),
    );
    const chCorpo = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorCli as never, {
        titulo: 'Problema ao emitir documento',
        descricao: 'O módulo de faturamento não conclui a emissão.',
        natureza: Natureza.problema,
      }),
    );
    const chOutro = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorCli as never, {
        titulo: 'Ajuste de cores do gráfico',
        descricao: 'Trocar a paleta do dashboard de vendas.',
        natureza: Natureza.alteracao,
      }),
    );
    if (!chTitulo.ok || !chCorpo.ok || !chOutro.ok) throw new Error('criação de busca falhou');

    // Tenant B também tem "faturamento" — não pode vazar para a busca do tenant A.
    const chB = await runInTenantContext(ds, tenantB, (em) =>
      criarChamado(em, atorCliB as never, {
        titulo: 'Falha no faturamento do tenant B',
        descricao: 'Isolamento cross-tenant da busca.',
        natureza: Natureza.problema,
      }),
    );
    if (!chB.ok) throw new Error('criação de busca (tenant B) falhou');

    // Busca com PLURAL prova o stemming português (faturamentos → faturamento).
    const buscaOp = await runInTenantContext(ds, tenantA, (em) =>
      listarFilaChamados(em, atorOp as never, { busca: 'faturamentos' }),
    );
    const idsBusca = buscaOp.itens.map((i) => i.id);
    ok(
      idsBusca.includes(chTitulo.id) && idsBusca.includes(chCorpo.id),
      'FTS casa título E corpo com stemming (plural → singular)',
    );
    ok(!idsBusca.includes(chOutro.id), 'FTS não retorna chamado sem o termo');
    ok(!idsBusca.includes(chB.id), 'FTS NÃO vaza chamado de outro tenant (RLS)');
    ok(
      buscaOp.itens[0]?.id === chTitulo.id,
      'ranking: match no TÍTULO vem acima do match no CORPO',
    );

    // Busca por número do chamado.
    const buscaNum = await runInTenantContext(ds, tenantA, (em) =>
      listarFilaChamados(em, atorOp as never, { busca: `#${chTitulo.numero}` }),
    );
    ok(
      buscaNum.itens.length >= 1 && buscaNum.itens.some((i) => i.id === chTitulo.id),
      'busca por número (#N) retorna o chamado correspondente',
    );

    // Portal do cliente: busca simples também filtra por FTS (só os próprios).
    const buscaCli = await runInTenantContext(ds, tenantA, (em) =>
      listarChamados(em, atorCli as never, { busca: 'faturamentos' }),
    );
    const idsCli = buscaCli.itens.map((i) => i.id);
    ok(
      idsCli.includes(chTitulo.id) && idsCli.includes(chCorpo.id) && !idsCli.includes(chB.id),
      'portal do cliente: busca FTS retorna os próprios chamados casados, sem vazar tenant',
    );

    // Isolamento inverso: no tenant B, a busca só vê o chamado de B.
    const buscaB = await runInTenantContext(ds, tenantB, (em) =>
      listarChamados(em, atorCliB as never, { busca: 'faturamento' }),
    );
    ok(
      buscaB.itens.every((i) => i.id === chB.id) && buscaB.itens.length === 1,
      'tenant B só encontra o próprio chamado na busca',
    );

    console.log(
      '\n[smoke-manutencao] RESULTADO: PASSOU — auto-fechamento, reabertura e busca FTS confirmados.',
    );
  } finally {
    await filaNotificacoes()
      .obliterate({ force: true })
      .catch(() => {});
    await filaNotificacoes()
      .close()
      .catch(() => {});
    await redis.del(CHAVE_LOCK_MANUTENCAO).catch(() => {});
    await redis.quit().catch(() => {});

    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "notificacao_log" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "preferencia_notificacao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "canal_notificacao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "evento_chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "mensagem" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "segredo" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-manutencao] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-manutencao] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
