/**
 * Smoke da camada de notificações (M9 — specs/06).
 *
 * Tenants DESCARTÁVEIS, transporte SMTP FAKE injetado e servidor HTTP local
 * capturando o webhook. Prova ponta a ponta:
 *   1. chamado criado → e-mail ao solicitante + webhook com HMAC VÁLIDO;
 *   2. atribuição → e-mail ao operador; mensagem pública → e-mail ao cliente
 *      (autor não se auto-notifica) com trecho público no webhook;
 *   3. nota interna → NENHUMA notificação (nem e-mail nem webhook);
 *   4. idempotência: reprocessar um job entregue NÃO reenvia;
 *   5. retry: falha temporária de SMTP re-tenta e depois entrega;
 *   6. webhook: sucesso ZERA o contador; N falhas consecutivas DESATIVAM o canal
 *      e ALERTAM o admin por e-mail;
 *   7. preferência desabilitada é respeitada; evento obrigatório não desabilitável;
 *   8. payload do webhook NUNCA inclui conteúdo interno;
 *   9. RLS das 3 tabelas novas (tenant B não enxerga dados do tenant A).
 *
 * Requer Postgres + Redis de pé. Sai 0 se passa; 1 caso contrário.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Transporter } from 'nodemailer';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

// Este smoke usa um receptor de webhook LOCAL (127.0.0.1) — o cenário de DEV que
// a flag anti-SSRF libera. Sem ela, o WebhookAdapter bloquearia hosts privados
// (specs/09 §5). Em produção a flag fica desligada e a URL nunca é privada.
process.env.NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO = 'true';

const {
  criarAppDataSource,
  criarAdminDataSource,
  runInTenantContext,
  provisionarTenant,
  criarUsuarioAtivoComSenha,
  criarChamado,
  criarMensagem,
  atribuirOperador,
  alterarPrioridade,
  salvarWebhook,
  buscarCanal,
  definirPreferencia,
  idCanalEmail,
  criarSecretStore,
  assinarWebhook,
  filaNotificacoes,
  CanalNotificacaoTipo,
  CanalNotificacaoSchema,
  PreferenciaNotificacaoSchema,
  NotificacaoLogSchema,
} = await import('@chamados/db');
type JobNotificacao = import('@chamados/db').JobNotificacao;
type JobFila = import('@chamados/db').JobFila;
// Shape estrutural do despachante coletor (capturaNotificacoes + publicar).
type Despachante = import('@chamados/db').DespachanteNotificacoes;

const { Papel, StatusTenant, Natureza, Prioridade, VisibilidadeMensagem } =
  await import('@chamados/shared');
const { GatewayRegistry } = await import('../notificacoes/registry');
const { SmtpAdapter } = await import('../notificacoes/smtp-adapter');
const { WebhookAdapter } = await import('../notificacoes/webhook-adapter');
const { processarNotificacao } = await import('../notificacoes/processador');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const SEGREDO_WEBHOOK = 'segredo-hmac-de-teste-123';

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-notificacoes] conectado como role da aplicação (sem bypass).');

  // ---- Transporte SMTP FAKE (captura e-mails; pode falhar sob demanda) ------
  const enviados: Array<{ to: string; subject: string; html?: string; text?: string }> = [];
  let falharSmtpProximas = 0;
  const transportFake = {
    sendMail: async (msg: { to?: unknown; subject?: unknown; html?: unknown; text?: unknown }) => {
      if (falharSmtpProximas > 0) {
        falharSmtpProximas--;
        throw new Error('SMTP indisponível (teste)');
      }
      enviados.push({
        to: String(msg.to ?? ''),
        subject: String(msg.subject ?? ''),
        html: msg.html as string | undefined,
        text: msg.text as string | undefined,
      });
      return { messageId: `fake-${enviados.length}` };
    },
  } as unknown as Transporter;

  // ---- Servidor HTTP local capturando o webhook -----------------------------
  const recebidos: Array<{ assinatura: string; evento: string; body: string }> = [];
  let webhookStatus = 200;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      recebidos.push({
        assinatura: String(req.headers['x-chamados-signature'] ?? ''),
        evento: String(req.headers['x-chamados-event'] ?? ''),
        body,
      });
      res.statusCode = webhookStatus;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const porta = (server.address() as AddressInfo).port;
  const urlWebhook = `http://127.0.0.1:${porta}/webhook`;

  // ---- Deps do processador (maxFalhas=2 para o teste de desativação) --------
  const registry = new GatewayRegistry()
    .registrar(new SmtpAdapter(transportFake))
    .registrar(new WebhookAdapter(3000));
  const config = {
    smtp: { host: 'localhost', port: 1025, secure: false, user: undefined, pass: undefined },
    remetente: { nome: 'Chamados', email: 'nao-responda@chamados.local' },
    webhook: { timeoutMs: 3000, maxFalhas: 2 },
    hostPlataforma: 'localhost:3000',
    concorrencia: 1,
  };
  const deps = { ds, registry, config, log: () => {} };

  async function processar(job: JobFila): Promise<{ desfecho: string } | { erro: string }> {
    try {
      return (await processarNotificacao(job, deps)) as { desfecho: string };
    } catch (e) {
      return { erro: (e as Error).message };
    }
  }

  await filaNotificacoes().obliterate({ force: true });

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-nt-a-${sufixo}`,
      nome: 'Notif A',
      nomeExibicao: 'Notif A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-nt-b-${sufixo}`,
      nome: 'Notif B',
      nomeExibicao: 'Notif B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    const usuarios = await runInTenantContext(ds, tenantA, async (em) => ({
      cliente: await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cliente.${sufixo}@a.dev`,
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
      admin: await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `admin.${sufixo}@a.dev`,
        nome: 'Ana Admin',
        papel: Papel.admin,
        senha: 'Dev@12345',
      }),
    }));
    const atorCliente = { id: usuarios.cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorOperador = { id: usuarios.operador, tenant_id: tenantA, papel: Papel.operador };
    const atorAdmin = { id: usuarios.admin, tenant_id: tenantA, papel: Papel.admin };
    const emailCliente = `cliente.${sufixo}@a.dev`;
    const emailOperador = `op.${sufixo}@a.dev`;
    const emailAdmin = `admin.${sufixo}@a.dev`;

    // Configura o webhook do tenant A.
    await runInTenantContext(ds, tenantA, (em) =>
      salvarWebhook(
        em,
        tenantA,
        { url: urlWebhook, segredo: SEGREDO_WEBHOOK, ativo: true },
        criarSecretStore(),
      ),
    );

    // Coletor: captura os jobs traduzidos pelo seam de auditoria (sem enfileirar).
    async function coletar(
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
      } as unknown as Despachante;
      await runInTenantContext(ds, tenantA, (em) => fn(em, { despachante }));
      return jobs;
    }

    // 1) Chamado criado → e-mail ao cliente + webhook com HMAC válido ---------
    let chamadoId = '';
    const jobsCriar = await coletar(async (em, hooks) => {
      const r = await criarChamado(
        em,
        atorCliente,
        {
          titulo: 'Erro ao salvar cadastro',
          descricao: 'Aparece um erro 500 ao salvar.',
          natureza: Natureza.problema,
          prioridade: Prioridade.alta,
        },
        hooks as never,
      );
      if (r.ok) chamadoId = r.id;
      return r;
    });
    ok(chamadoId !== '', 'chamado criado');
    const emailCriar = jobsCriar.find((j) => j.canal === 'email');
    const webhookCriar = jobsCriar.find((j) => j.canal === 'webhook');
    ok(
      !!emailCriar && emailCriar.destinatarioId === usuarios.cliente,
      'job de e-mail para o cliente',
    );
    ok(!!webhookCriar, 'job de webhook para o chamado criado');

    await processar(emailCriar!);
    ok(
      enviados.some((e) => e.to === emailCliente && /Recebemos seu chamado/.test(e.subject)),
      'e-mail de confirmação entregue ao cliente (SMTP fake)',
    );

    await processar(webhookCriar!);
    ok(recebidos.length === 1, 'webhook recebeu 1 POST');
    const rc = recebidos[0]!;
    const esperada = assinarWebhook(SEGREDO_WEBHOOK, rc.body);
    ok(rc.assinatura === esperada, 'assinatura HMAC do webhook confere (recalculada)');
    ok(rc.evento === 'criado', 'header X-Chamados-Event = criado');
    const payloadCriar = JSON.parse(rc.body) as {
      chamado: { titulo: string };
      evento: { tipo: string };
    };
    ok(
      payloadCriar.chamado.titulo === 'Erro ao salvar cadastro',
      'payload traz o título do chamado',
    );
    ok(payloadCriar.evento.tipo === 'criado', 'payload evento.tipo = criado');
    ok(
      !/complexidade/i.test(rc.body),
      'payload do webhook NÃO contém complexidade (sem conteúdo interno)',
    );

    // 2) Atribuição (feita pelo admin) → e-mail ao operador atribuído ----------
    // O autor da ação (admin) não é notificado; o operador atribuído, sim.
    const jobsAtrib = await coletar((em, hooks) =>
      atribuirOperador(em, atorAdmin, chamadoId, usuarios.operador, hooks as never),
    );
    const emailAtrib = jobsAtrib.find((j) => j.canal === 'email');
    ok(
      !!emailAtrib && emailAtrib.destinatarioId === usuarios.operador,
      'job de e-mail para o operador atribuído',
    );
    await processar(emailAtrib!);
    ok(
      enviados.some((e) => e.to === emailOperador && /responsável/i.test(e.subject)),
      'e-mail de atribuição entregue ao operador',
    );

    // 3) Mensagem pública do operador → e-mail ao cliente (autor não recebe) ---
    const jobsMsg = await coletar((em, hooks) =>
      criarMensagem(
        em,
        atorOperador,
        {
          chamado_id: chamadoId,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Olá, pode enviar o print do erro?',
        },
        hooks as never,
      ),
    );
    const emailsMsg = jobsMsg.filter((j) => j.canal === 'email');
    ok(
      emailsMsg.length === 1 && emailsMsg[0]!.destinatarioId === usuarios.cliente,
      'mensagem pública notifica só o cliente (operador autor não se auto-notifica)',
    );
    const webhookMsg = jobsMsg.find((j) => j.canal === 'webhook');
    await processar(webhookMsg!);
    const rMsg = recebidos[recebidos.length - 1]!;
    const payloadMsg = JSON.parse(rMsg.body) as {
      mensagem?: { trecho: string };
      autor?: { nome: string };
    };
    ok(
      !!payloadMsg.mensagem && /print do erro/.test(payloadMsg.mensagem.trecho),
      'webhook traz o trecho PÚBLICO da mensagem',
    );
    ok(
      !!payloadMsg.autor && payloadMsg.autor.nome === 'Olga Operadora',
      'webhook traz o autor da mensagem',
    );

    // 4) Nota interna → NENHUMA notificação -----------------------------------
    const recebidosAntes = recebidos.length;
    const jobsInterna = await coletar((em, hooks) =>
      criarMensagem(
        em,
        atorOperador,
        {
          chamado_id: chamadoId,
          visibilidade: VisibilidadeMensagem.interna,
          corpo: 'Nota interna: complexidade média, verificar stacktrace.',
        },
        hooks as never,
      ),
    );
    ok(jobsInterna.length === 0, 'nota interna NÃO gera nenhum job de notificação');
    ok(recebidos.length === recebidosAntes, 'nota interna NÃO dispara webhook');

    // 5) Idempotência: reprocessar o e-mail de criação NÃO reenvia ------------
    const enviadosAntes = enviados.length;
    const r5 = await processar(emailCriar!);
    ok(
      'desfecho' in r5 && r5.desfecho === 'ignorado',
      'reprocesso de e-mail já entregue → ignorado',
    );
    ok(enviados.length === enviadosAntes, 'idempotência: nenhum e-mail duplicado');

    // 6) Retry: falha temporária de SMTP re-tenta e entrega -------------------
    let chamado2 = '';
    const jobs2 = await coletar(async (em, hooks) => {
      const r = await criarChamado(
        em,
        atorCliente,
        { titulo: 'Segundo chamado', descricao: 'Teste de retry.', natureza: Natureza.problema },
        hooks as never,
      );
      if (r.ok) chamado2 = r.id;
      return r;
    });
    void chamado2;
    const email2 = jobs2.find((j) => j.canal === 'email')!;
    falharSmtpProximas = 1;
    const r6a = await processar(email2);
    ok('erro' in r6a, 'falha temporária de SMTP → THROW (BullMQ re-tentaria)');
    const enviadosAntes6 = enviados.length;
    const r6b = await processar(email2);
    ok('desfecho' in r6b && r6b.desfecho === 'entregue', 'retry entrega o e-mail na 2ª tentativa');
    ok(enviados.length === enviadosAntes6 + 1, 'retry envia exatamente 1 e-mail');
    const log2 = await runInTenantContext(ds, tenantA, (em) =>
      em.query(`SELECT tentativas FROM notificacao_log WHERE idempotency_key=$1`, [
        email2.idempotencyKey,
      ]),
    );
    ok(Number(log2[0]?.tentativas) >= 2, 'NotificacaoLog registra ≥2 tentativas');

    // 7) Preferência desabilitada respeitada + obrigatório não desabilitável ---
    const canalEmailId = await runInTenantContext(ds, tenantA, (em) => idCanalEmail(em));
    ok(!!canalEmailId, 'canal de e-mail default existe (provisionamento)');
    const rPrefDesab = await runInTenantContext(ds, tenantA, (em) =>
      definirPreferencia(
        em,
        tenantA,
        usuarios.cliente,
        'mudanca_prioridade',
        canalEmailId!,
        false,
        'cliente',
      ),
    );
    ok(rPrefDesab.ok, 'cliente desabilita a preferência de mudança de prioridade');
    const jobsPref = await coletar((em, hooks) =>
      alterarPrioridade(em, atorOperador, chamadoId, Prioridade.urgente, hooks as never),
    );
    ok(
      jobsPref.filter((j) => j.canal === 'email').length === 0,
      'preferência desabilitada respeitada: cliente NÃO recebe e-mail de prioridade',
    );
    const rObrig = await runInTenantContext(ds, tenantA, (em) =>
      definirPreferencia(
        em,
        tenantA,
        usuarios.cliente,
        'chamado_criado',
        canalEmailId!,
        false,
        'cliente',
      ),
    );
    ok(
      !rObrig.ok && rObrig.motivo === 'obrigatorio',
      'evento obrigatório (chamado_criado) NÃO é desabilitável',
    );

    // 9) Webhook: sucesso zera contador; N falhas desativam + alerta admin -----
    // Coleta 4 jobs de webhook (com o canal ainda ativo) via 4 mudanças de prioridade.
    const webhookJobs: JobNotificacao[] = [];
    const prios = [Prioridade.media, Prioridade.alta, Prioridade.baixa, Prioridade.media];
    for (const p of prios) {
      const js = await coletar((em, hooks) =>
        alterarPrioridade(em, atorOperador, chamadoId, p, hooks as never),
      );
      const w = js.find((j) => j.canal === 'webhook');
      if (w) webhookJobs.push(w);
    }
    ok(webhookJobs.length === 4, 'coletou 4 jobs de webhook para o teste de circuito');

    // sucesso zera: 1 falha (contador=1) e depois 1 sucesso (contador=0).
    webhookStatus = 500;
    await processar(webhookJobs[0]!);
    let canal = await runInTenantContext(ds, tenantA, (em) =>
      buscarCanal(em, CanalNotificacaoTipo.webhook),
    );
    ok(canal?.falhas_consecutivas === 1, 'falha de webhook incrementa o contador (=1)');
    webhookStatus = 200;
    await processar(webhookJobs[1]!);
    canal = await runInTenantContext(ds, tenantA, (em) =>
      buscarCanal(em, CanalNotificacaoTipo.webhook),
    );
    ok(canal?.falhas_consecutivas === 0, 'sucesso de webhook ZERA o contador (=0)');
    ok(canal?.ativo === true, 'canal continua ativo após sucesso');

    // desativação: 2 falhas consecutivas (maxFalhas=2) → desativa + alerta admin.
    webhookStatus = 500;
    await processar(webhookJobs[2]!);
    await processar(webhookJobs[3]!);
    canal = await runInTenantContext(ds, tenantA, (em) =>
      buscarCanal(em, CanalNotificacaoTipo.webhook),
    );
    ok(canal?.ativo === false, 'webhook DESATIVADO após 2 falhas consecutivas');
    ok(canal?.desativado_em != null, 'desativado_em preenchido');
    // O alerta ao admin é ENFILEIRADO pelo processador (fila `notificacoes`). Como
    // um worker de dev pode consumi-lo antes daqui, validamos o CAMINHO do alerta
    // processando um job de alerta diretamente (mesmo caminho de renderização/envio).
    const enviadosAntesAlerta = enviados.length;
    const jobAlerta = {
      especie: 'alerta_webhook' as const,
      idempotencyKey: `alerta-teste-${randomUUID()}`,
      tenantId: tenantA,
      canal: 'email' as const,
      destinatarioId: usuarios.admin,
      motivo: 'falhas consecutivas de entrega',
    };
    await processar(jobAlerta);
    ok(
      enviados.some((e) => e.to === emailAdmin && /Webhook/i.test(e.subject)) &&
        enviados.length === enviadosAntesAlerta + 1,
      'admin recebe e-mail de alerta de webhook desativado',
    );

    // 8/10) RLS das 3 tabelas novas (tenant B não enxerga dados do tenant A) ---
    await runInTenantContext(ds, tenantB, async (em) => {
      const canais = await em.find(CanalNotificacaoSchema, {});
      ok(
        canais.every((c) => c.tenant_id === tenantB),
        'RLS canal_notificacao: tenant B só vê os próprios',
      );
      const prefs = await em.find(PreferenciaNotificacaoSchema, {});
      ok(
        prefs.every((p) => p.tenant_id === tenantB),
        'RLS preferencia_notificacao: isolado',
      );
      const logs = await em.find(NotificacaoLogSchema, {});
      ok(
        logs.every((l) => l.tenant_id === tenantB),
        'RLS notificacao_log: tenant B não vê logs do tenant A',
      );
      ok(logs.length === 0, 'tenant B não tem nenhum log (nenhuma notificação disparada nele)');
    });

    console.log(
      '\n[smoke-notificacoes] RESULTADO: PASSOU — notificações SMTP + webhook confirmadas.',
    );
  } finally {
    await filaNotificacoes()
      .obliterate({ force: true })
      .catch(() => {});
    await filaNotificacoes()
      .close()
      .catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));

    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "notificacao_log" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "preferencia_notificacao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "canal_notificacao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "mensagem" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "evento_chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "segredo" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-notificacoes] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-notificacoes] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
