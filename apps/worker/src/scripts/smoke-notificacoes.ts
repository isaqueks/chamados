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
 *   9. RLS das 3 tabelas novas (tenant B não enxerga dados do tenant A);
 *  10. janela de aprovação (D-042): e-mail de resolvido com prazo; aprovação
 *      explícita → webhook `aprovado` (forma explicita + autor), sem `fechado`;
 *      aprovação TÁCITA → webhook `aprovado` (forma tacita) entregue UMA vez
 *      (reprocesso e reconciliação não duplicam); contestação → webhook
 *      `contestado` com o trecho do motivo.
 *  11. custo (D-043): estimativa → webhook `estimativa_custo_alterada` (mudanca
 *      com códigos; `chamado.estimativa_custo` com rótulo/faixa); e-mail opt-in
 *      (nenhum sem preferência); resolver COM custo → webhook `resolvido` com
 *      `chamado.custo_final` e e-mail de resolvido mostrando o valor, sem webhook
 *      `custo_final_definido` duplicado; correção depois → webhook
 *      `custo_final_definido` com mudanca numérica e e-mail ao cliente.
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
  transicionarStatus,
  atorSistema,
  definirEstimativaCusto,
  definirCustoFinal,
  aprovarResolucao,
  contestarResolucao,
  fecharChamadosResolvidosVencidos,
  reconciliarWebhooksAprovacaoTacita,
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

const {
  Papel,
  StatusTenant,
  StatusChamado,
  Natureza,
  Prioridade,
  VisibilidadeMensagem,
  EstimativaCusto,
} = await import('@chamados/shared');
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

    // 10) Janela de aprovação do cliente (D-042) ------------------------------
    type PayloadAprov = {
      evento: { tipo: string; id: string };
      chamado: { status: string };
      aprovacao: { forma: string } | null;
      autor: { nome: string } | null;
      mensagem: { trecho: string } | null;
      mudanca: { de: string | null; para: string | null } | null;
    };
    const ultimoWebhook = (): { evento: string; payload: PayloadAprov; body: string } => {
      const r = recebidos[recebidos.length - 1]!;
      return { evento: r.evento, payload: JSON.parse(r.body) as PayloadAprov, body: r.body };
    };
    /** Cria um chamado do cliente, atribui ao operador e leva a `resolvido`. */
    async function resolvidoAtribuido(
      titulo: string,
    ): Promise<{ id: string; jobs: JobNotificacao[] }> {
      let id = '';
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarChamado(em, atorCliente, {
          titulo,
          descricao: 'Janela de aprovação (D-042).',
          natureza: Natureza.problema,
        });
        if (!r.ok) throw new Error('criarChamado falhou');
        id = r.id;
        await transicionarStatus(em, atorSistema(tenantA), id, StatusChamado.em_triagem);
        await transicionarStatus(em, atorOperador, id, StatusChamado.em_atendimento);
        await atribuirOperador(em, atorOperador, id, usuarios.operador);
      });
      const jobs = await coletar((em, hooks) =>
        transicionarStatus(em, atorOperador, id, StatusChamado.resolvido, {}, hooks as never),
      );
      return { id, jobs };
    }

    // 10a) E-mail de resolvido ao cliente informa o prazo e a aprovação tácita.
    const ap = await resolvidoAtribuido('Aprovação explícita');
    const emailResolvido = ap.jobs.find(
      (j) => j.canal === 'email' && j.destinatarioId === usuarios.cliente,
    );
    ok(
      !!emailResolvido && emailResolvido.evento === 'resolvido',
      'D-042: job de e-mail de resolvido ao cliente',
    );
    await processar(emailResolvido!);
    const mailResolvido = enviados[enviados.length - 1]!;
    ok(
      mailResolvido.to === emailCliente &&
        /aprove ou conteste/i.test(mailResolvido.subject) &&
        /Você tem até .+ para aprovar ou contestar/.test(mailResolvido.text ?? '') &&
        /considerado aprovado/.test(mailResolvido.text ?? ''),
      'D-042: e-mail de resolvido traz o prazo e avisa da aprovação tácita',
    );

    // 10b) Aprovação EXPLÍCITA → webhook `aprovado` (explicita + autor); sem `fechado`.
    const jobsAp = await coletar((em, hooks) =>
      aprovarResolucao(em, atorCliente, ap.id, hooks as never),
    );
    const whAp = jobsAp.filter((j) => j.canal === 'webhook');
    ok(
      whAp.length === 1 && whAp[0]!.evento === 'aprovado',
      'D-042: aprovação explícita gera UM webhook `aprovado` (nenhum `fechado`)',
    );
    ok(
      jobsAp.some((j) => j.canal === 'email' && j.destinatarioId === usuarios.operador) &&
        !jobsAp.some((j) => j.canal === 'email' && j.destinatarioId === usuarios.cliente),
      'D-042: e-mail de aprovação vai ao responsável; o cliente autor não se auto-notifica',
    );
    await processar(whAp[0]!);
    const wAp = ultimoWebhook();
    ok(wAp.evento === 'aprovado', 'D-042: header X-Chamados-Event = aprovado');
    ok(
      wAp.payload.aprovacao?.forma === 'explicita' && wAp.payload.autor?.nome === 'Carla Cliente',
      'D-042: payload aprovado traz forma explicita e o autor',
    );
    ok(
      wAp.payload.mudanca?.de === 'resolvido' &&
        wAp.payload.mudanca?.para === 'fechado' &&
        wAp.payload.chamado.status === 'fechado',
      'D-042: payload aprovado traz a mudança resolvido → fechado',
    );
    ok(!/complexidade|interna/i.test(wAp.body), 'D-042: payload aprovado sem conteúdo interno');

    // 10c) Aprovação TÁCITA → webhook `aprovado` tácito, entregue UMA única vez.
    const tac = await resolvidoAtribuido('Aprovação tácita');
    const daqui8Dias = new Date(Date.now() + 8 * 86_400_000);
    const jobsTac = await coletar((em, hooks) =>
      fecharChamadosResolvidosVencidos(em, tenantA, hooks as never, daqui8Dias),
    );
    const whTac = jobsTac.filter((j) => j.canal === 'webhook' && j.chamadoId === tac.id);
    ok(
      whTac.length === 1 &&
        whTac[0]!.evento === 'aprovado' &&
        whTac[0]!.contexto.aprovacao === 'tacita',
      'D-042: aprovação tácita gera UM webhook `aprovado` (forma tacita)',
    );
    const antesTac = recebidos.length;
    await processar(whTac[0]!);
    const wTac = ultimoWebhook();
    ok(
      recebidos.length === antesTac + 1 &&
        wTac.evento === 'aprovado' &&
        wTac.payload.aprovacao?.forma === 'tacita' &&
        wTac.payload.autor === null,
      'D-042: webhook tácito entregue (forma tacita, sem autor)',
    );
    const reproc = await processar(whTac[0]!);
    ok(
      'desfecho' in reproc && reproc.desfecho === 'ignorado' && recebidos.length === antesTac + 1,
      'D-042: reprocessar o webhook tácito NÃO reenvia',
    );
    const jobsRec = await coletar((em, hooks) =>
      reconciliarWebhooksAprovacaoTacita(em, tenantA, hooks as never),
    );
    ok(
      !jobsRec.some((j) => j.chamadoId === tac.id),
      'D-042: reconciliação não republica o webhook já entregue (chave do evento)',
    );

    // 10d) CONTESTAÇÃO → webhook `contestado` com o motivo (trecho público).
    const ct = await resolvidoAtribuido('Contestação');
    const jobsCt = await coletar((em, hooks) =>
      contestarResolucao(
        em,
        atorCliente,
        ct.id,
        'O boleto continua saindo sem código.',
        hooks as never,
      ),
    );
    const whCt = jobsCt.find((j) => j.canal === 'webhook' && j.evento === 'contestado');
    ok(!!whCt, 'D-042: contestação gera webhook `contestado`');
    ok(
      jobsCt.some(
        (j) =>
          j.canal === 'email' &&
          j.evento === 'contestado' &&
          j.destinatarioId === usuarios.operador,
      ),
      'D-042: contestação avisa o operador responsável',
    );
    await processar(whCt!);
    const wCt = ultimoWebhook();
    ok(
      wCt.evento === 'contestado' &&
        /boleto continua/.test(wCt.payload.mensagem?.trecho ?? '') &&
        wCt.payload.autor?.nome === 'Carla Cliente' &&
        wCt.payload.mudanca?.para === 'em_atendimento' &&
        wCt.payload.aprovacao === null,
      'D-042: payload contestado traz motivo, autor e mudança (sem `aprovacao`)',
    );

    // 11) Custo do chamado (D-043) — ANTES do teste de circuito (que desativa o webhook).
    type PayloadCusto = {
      evento: { tipo: string };
      chamado: {
        status: string;
        estimativa_custo: {
          codigo: string;
          rotulo: string;
          min: number;
          max: number | null;
        } | null;
        custo_final: number | null;
      };
      mudanca: { de: string | number | null; para: string | number | null } | null;
    };
    const ultimoCusto = (): { evento: string; payload: PayloadCusto } => {
      const r = recebidos[recebidos.length - 1]!;
      return { evento: r.evento, payload: JSON.parse(r.body) as PayloadCusto };
    };
    let chCusto = '';
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCliente, {
        titulo: 'Custo do chamado',
        descricao: 'Estimativa e custo final (D-043).',
        natureza: Natureza.alteracao,
      });
      if (!r.ok) throw new Error('criarChamado (custo) falhou');
      chCusto = r.id;
      await transicionarStatus(em, atorSistema(tenantA), chCusto, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOperador, chCusto, StatusChamado.em_atendimento);
    });

    // 11a) Estimativa → webhook com mudanca de códigos; e-mail só com opt-in.
    const jobsEst = await coletar((em, hooks) =>
      definirEstimativaCusto(em, atorOperador, chCusto, EstimativaCusto.C, hooks as never),
    );
    const whEst = jobsEst.find((j) => j.canal === 'webhook');
    ok(!!whEst && whEst.evento === 'estimativa_custo', 'D-043: estimativa gera job de webhook');
    ok(
      !jobsEst.some((j) => j.canal === 'email'),
      'D-043: estimativa é opt-in — nenhum e-mail sem preferência ligada',
    );
    await processar(whEst!);
    const wEst = ultimoCusto();
    ok(
      wEst.evento === 'estimativa_custo_alterada' &&
        wEst.payload.evento.tipo === 'estimativa_custo_alterada' &&
        wEst.payload.mudanca?.de === null &&
        wEst.payload.mudanca?.para === 'C',
      'D-043: webhook estimativa_custo_alterada com mudanca { de: null, para: "C" }',
    );
    ok(
      wEst.payload.chamado.estimativa_custo?.codigo === 'C' &&
        wEst.payload.chamado.estimativa_custo.rotulo === 'C · R$ 200 a R$ 400' &&
        wEst.payload.chamado.estimativa_custo.min === 200 &&
        wEst.payload.chamado.custo_final === null,
      'D-043: payload traz estimativa (código, rótulo, faixa) e custo_final null',
    );
    const jobsEstIgual = await coletar((em, hooks) =>
      definirEstimativaCusto(em, atorOperador, chCusto, EstimativaCusto.C, hooks as never),
    );
    ok(jobsEstIgual.length === 0, 'D-043: mesma estimativa → nenhum webhook (idempotente)');
    // Com a preferência LIGADA, o cliente recebe o e-mail da estimativa.
    const rOptIn = await runInTenantContext(ds, tenantA, async (em) => {
      const canalEmail = await idCanalEmail(em);
      return definirPreferencia(
        em,
        tenantA,
        usuarios.cliente,
        'estimativa_custo',
        canalEmail!,
        true,
        'cliente',
      );
    });
    ok(rOptIn.ok, 'D-043: cliente liga a preferência de estimativa de custo');
    const jobsEstOptIn = await coletar((em, hooks) =>
      definirEstimativaCusto(em, atorOperador, chCusto, EstimativaCusto.D, hooks as never),
    );
    const mailEst = jobsEstOptIn.find(
      (j) => j.canal === 'email' && j.destinatarioId === usuarios.cliente,
    );
    ok(!!mailEst, 'D-043: com opt-in, e-mail de estimativa ao cliente');
    await processar(mailEst!);
    ok(
      /estimativa de custo D · R\$ 400 a R\$ 600/.test(enviados[enviados.length - 1]!.subject),
      'D-043: assunto do e-mail traz a faixa nova',
    );

    // 11b) Resolver COM custo → `resolvido` carrega o valor; nada de custo duplicado.
    const jobsRes = await coletar((em, hooks) =>
      transicionarStatus(
        em,
        atorOperador,
        chCusto,
        StatusChamado.resolvido,
        { custo_final: 250 },
        hooks as never,
      ),
    );
    ok(
      !jobsRes.some((j) => j.evento === 'custo_final'),
      'D-043: custo no ato de resolver NÃO gera notificação/webhook custo_final_definido',
    );
    const whRes = jobsRes.find((j) => j.canal === 'webhook' && j.evento === 'resolvido');
    const mailRes = jobsRes.find(
      (j) => j.canal === 'email' && j.destinatarioId === usuarios.cliente,
    );
    ok(!!whRes && !!mailRes, 'D-043: resolvido gera webhook e e-mail ao cliente');
    await processar(whRes!);
    const wRes = ultimoCusto();
    ok(
      wRes.evento === 'resolvido' &&
        wRes.payload.chamado.custo_final === 250 &&
        wRes.payload.chamado.estimativa_custo?.codigo === 'D',
      'D-043: webhook resolvido traz chamado.custo_final = 250 e a estimativa',
    );
    await processar(mailRes!);
    ok(
      /Custo final: R\$ 250,00/.test(enviados[enviados.length - 1]!.text ?? ''),
      'D-043: e-mail de resolvido mostra o custo final',
    );

    // 11c) Correção depois → webhook custo_final_definido com mudanca numérica.
    const jobsCorr = await coletar((em, hooks) =>
      definirCustoFinal(em, atorOperador, chCusto, 275.5, hooks as never),
    );
    const whCorr = jobsCorr.find((j) => j.canal === 'webhook');
    ok(!!whCorr && whCorr.evento === 'custo_final', 'D-043: correção do custo gera webhook');
    ok(
      jobsCorr.some((j) => j.canal === 'email' && j.destinatarioId === usuarios.cliente),
      'D-043: correção do custo avisa o cliente (ligado por padrão)',
    );
    await processar(whCorr!);
    const wCorr = ultimoCusto();
    ok(
      wCorr.evento === 'custo_final_definido' &&
        wCorr.payload.mudanca?.de === 250 &&
        wCorr.payload.mudanca?.para === 275.5 &&
        wCorr.payload.chamado.custo_final === 275.5,
      'D-043: payload custo_final_definido com mudanca { de: 250, para: 275.5 }',
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
