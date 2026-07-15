import type { DataSource, EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import {
  runInTenantContext,
  criarSecretStore,
  lerSegredoWebhook,
  registrarFalhaWebhook,
  zerarFalhasWebhook,
  enfileirarNotificacao,
  chaveIdempotenciaTransacional,
  statusEhSucesso,
  StatusNotificacao,
  CATALOGO_NOTIFICACOES,
  TenantSchema,
  ChamadoSchema,
  UsuarioSchema,
  MensagemSchema,
  SistemaAlvoSchema,
  CategoriaSchema,
  CanalNotificacaoSchema,
  type Tenant,
  type JobFila,
  type JobNotificacao,
  type JobTransacional,
  type JobAlertaWebhook,
  type EventoNotificavel,
  type PayloadWebhook,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import type { GatewayRegistry } from './registry';
import type { CanalConfig, EnvioResultado, NotificationPayload } from './tipos';
import type { NotificacoesConfig } from './config';
import {
  montarEmailChamado,
  montarEmailAlertaWebhook,
  montarEmailTransacional,
  montarPayloadWebhook,
} from './templates';

export interface DepsProcessador {
  ds: DataSource;
  registry: GatewayRegistry;
  config: NotificacoesConfig;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Resultado da tentativa (para observabilidade/smoke). */
export type ResultadoProcessamento =
  | { desfecho: 'ignorado' }
  | { desfecho: 'entregue' | 'aceito' }
  | { desfecho: 'falha_permanente'; erro?: string };
// `falha_temporaria` é sinalizada por THROW (para o BullMQ re-tentar).

// ---------------------------------------------------------------------------
// Helpers de log de idempotência
// ---------------------------------------------------------------------------

interface DadosLog {
  tenantId: string;
  idempotencyKey: string;
  chamadoId: string | null;
  evento: string;
  canal: 'email' | 'webhook';
  destinatarioId: string | null;
  destino: string;
}

/** Reivindica (insert-if-not-exists) a linha do log; devolve o status atual. */
async function reivindicarLog(
  em: EntityManager,
  d: DadosLog,
): Promise<{ status: StatusNotificacao; tentativas: number }> {
  await em.query(
    `INSERT INTO notificacao_log
       (tenant_id, idempotency_key, chamado_id, evento, canal, destinatario_id, destino, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [d.tenantId, d.idempotencyKey, d.chamadoId, d.evento, d.canal, d.destinatarioId, d.destino],
  );
  const linhas: Array<{ status: StatusNotificacao; tentativas: number }> = await em.query(
    `SELECT status, tentativas FROM notificacao_log WHERE idempotency_key = $1`,
    [d.idempotencyKey],
  );
  return linhas[0]!;
}

async function atualizarLog(
  em: EntityManager,
  idempotencyKey: string,
  r: EnvioResultado,
): Promise<void> {
  await em.query(
    `UPDATE notificacao_log
        SET status = $2, tentativas = tentativas + 1,
            ultimo_erro = $3, id_externo = $4, updated_at = now()
      WHERE idempotency_key = $1`,
    [idempotencyKey, r.status, r.erro ?? null, r.idExterno ?? null],
  );
}

// ---------------------------------------------------------------------------
// Helpers de branding / links / texto
// ---------------------------------------------------------------------------

function corDe(tenant: Tenant): string {
  return tenant.config_branding?.cor_primaria ?? '#2563eb';
}

function remetenteDe(tenant: Tenant, config: NotificacoesConfig): string {
  const nome =
    tenant.config_branding?.email_remetente_nome || tenant.nome_exibicao || config.remetente.nome;
  const email = tenant.config_branding?.email_remetente_endereco || config.remetente.email;
  return `${nome} <${email}>`;
}

function linkChamado(
  tenant: Tenant,
  chamadoId: string,
  area: 'portal' | 'app',
  hostPlataforma: string,
): string {
  if (tenant.dominio_proprio) {
    return `https://${tenant.dominio_proprio}/${area}/chamados/${chamadoId}`;
  }
  const proto = hostPlataforma.includes('localhost') ? 'http' : 'https';
  return `${proto}://${tenant.slug}.${hostPlataforma}/${area}/chamados/${chamadoId}`;
}

function linkConfig(tenant: Tenant, hostPlataforma: string): string {
  if (tenant.dominio_proprio) return `https://${tenant.dominio_proprio}/app/config`;
  const proto = hostPlataforma.includes('localhost') ? 'http' : 'https';
  return `${proto}://${tenant.slug}.${hostPlataforma}/app/config`;
}

/** Extrai um trecho de texto seguro de um HTML (strip de tags + colapso). */
function trechoDeHtml(html: string, max = 240): string {
  const texto = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

const canalConfigEmail = (tenant: Tenant, config: NotificacoesConfig): CanalConfig => ({
  tenantId: tenant.id,
  tipo: 'email',
  segredos: {},
  remetente: remetenteDe(tenant, config),
});

// ---------------------------------------------------------------------------
// Envio genérico de e-mail (transacional / alerta): claim → send → update
// ---------------------------------------------------------------------------

async function enviarEmail(
  deps: DepsProcessador,
  tenantId: string,
  logDados: DadosLog,
  render: (tenant: Tenant) => { assunto: string; texto: string; html: string },
  destinoEmail: (em: EntityManager) => Promise<{ destino: string; tenant: Tenant } | null>,
): Promise<ResultadoProcessamento> {
  const preparo = await runInTenantContext(deps.ds, tenantId, async (em) => {
    const alvo = await destinoEmail(em);
    if (!alvo) return null;
    const log = await reivindicarLog(em, { ...logDados, destino: alvo.destino });
    if (statusEhSucesso(log.status)) return { skip: true as const };
    const { assunto, texto, html } = render(alvo.tenant);
    return {
      skip: false as const,
      destino: alvo.destino,
      config: canalConfigEmail(alvo.tenant, deps.config),
      payload: {
        canal: 'email' as const,
        destino: alvo.destino,
        assunto,
        corpoTexto: texto,
        corpoHtml: html,
      },
    };
  });

  if (!preparo) return { desfecho: 'falha_permanente', erro: 'destino inexistente' };
  if (preparo.skip) return { desfecho: 'ignorado' };

  const gateway = deps.registry.obter('email');
  const resultado: EnvioResultado = gateway
    ? await gateway.enviar(preparo.payload, preparo.config)
    : { status: 'falha_temporaria', erro: 'sem gateway de e-mail' };

  await runInTenantContext(deps.ds, tenantId, (em) =>
    atualizarLog(em, logDados.idempotencyKey, resultado),
  );

  if (resultado.status === 'falha_temporaria') {
    throw new Error(`falha temporária: ${resultado.erro ?? 'e-mail'}`);
  }
  if (resultado.status === 'falha_permanente') {
    return { desfecho: 'falha_permanente', erro: resultado.erro };
  }
  return { desfecho: resultado.status };
}

// ---------------------------------------------------------------------------
// Evento de chamado (e-mail por destinatário OU webhook)
// ---------------------------------------------------------------------------

interface ChamadoRender {
  tenant: Tenant;
  numero: string;
  titulo: string;
  status: string;
  prioridade: string;
  natureza: string;
  cliente_id: string;
  operador_id: string | null;
  sistema_alvo_id: string | null;
  categoria_id: string | null;
}

async function processarChamado(
  job: JobNotificacao,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  const cat = CATALOGO_NOTIFICACOES[job.evento as EventoNotificavel];

  // ---- Fase A: reivindica idempotência + carrega tudo p/ renderizar --------
  const fase = await runInTenantContext(deps.ds, job.tenantId, async (em) => {
    const tenant = await em.findOne(TenantSchema, { where: { id: job.tenantId } });
    const chamado = (await em.findOne(ChamadoSchema, {
      where: { id: job.chamadoId, deleted_at: IsNull() },
    })) as ChamadoRender | null;
    if (!tenant || !chamado) return { tipo: 'abortar' as const };

    // Destino + config por canal.
    let destino = '';
    let destinatarioNome: string | null = null;
    let papelArea: 'portal' | 'app' = 'portal';
    let webhookCanalId: string | null = null;
    let canalConfig: CanalConfig;

    if (job.canal === 'email') {
      const u = await em.findOne(UsuarioSchema, {
        where: { id: job.destinatarioId!, deleted_at: IsNull() },
      });
      if (!u?.email) return { tipo: 'permanente' as const };
      destino = u.email;
      destinatarioNome = u.nome;
      papelArea = u.papel === Papel.cliente ? 'portal' : 'app';
      canalConfig = canalConfigEmail(tenant, deps.config);
    } else {
      const canal = await em.findOne(CanalNotificacaoSchema, {
        where: { tipo: 'webhook', deleted_at: IsNull() },
      });
      if (!canal?.ativo || !canal.config?.url) return { tipo: 'abortar' as const };
      const segredo = (await lerSegredoWebhook(em, canal, criarSecretStore())) ?? '';
      destino = canal.config.url;
      webhookCanalId = canal.id;
      canalConfig = { tenantId: tenant.id, tipo: 'webhook', segredos: { segredo } };
    }

    // Claim de idempotência.
    const log = await reivindicarLog(em, {
      tenantId: job.tenantId,
      idempotencyKey: job.idempotencyKey,
      chamadoId: job.chamadoId,
      evento: job.evento,
      canal: job.canal,
      destinatarioId: job.destinatarioId ?? null,
      destino,
    });
    if (statusEhSucesso(log.status)) return { tipo: 'skip' as const };

    // Extras: autor + trecho público (mensagem), sistema/categoria (webhook).
    let autorNome: string | null = null;
    let trechoPublico: string | null = null;
    if (job.contexto.mensagemId && job.evento === 'mensagem_publica') {
      const msg = await em.findOne(MensagemSchema, {
        where: { id: job.contexto.mensagemId, deleted_at: IsNull() },
      });
      if (msg && msg.visibilidade === 'publica') {
        trechoPublico = trechoDeHtml(msg.corpo_html ?? '');
        const autor = await em.findOne(UsuarioSchema, { where: { id: msg.autor_id } });
        autorNome = autor?.nome ?? null;
      }
    }

    let sistemaNome: string | null = null;
    let categoriaNome: string | null = null;
    if (job.canal === 'webhook') {
      if (chamado.sistema_alvo_id) {
        const s = await em.findOne(SistemaAlvoSchema, { where: { id: chamado.sistema_alvo_id } });
        sistemaNome = s?.nome ?? null;
      }
      if (chamado.categoria_id) {
        const c = await em.findOne(CategoriaSchema, { where: { id: chamado.categoria_id } });
        categoriaNome = c?.nome ?? null;
      }
    }

    const link = linkChamado(tenant, job.chamadoId, papelArea, deps.config.hostPlataforma);

    return {
      tipo: 'enviar' as const,
      tenant,
      chamado,
      destino,
      destinatarioNome,
      canalConfig,
      webhookCanalId,
      autorNome,
      trechoPublico,
      sistemaNome,
      categoriaNome,
      link,
    };
  });

  if (fase.tipo === 'abortar') return { desfecho: 'ignorado' };
  if (fase.tipo === 'skip') return { desfecho: 'ignorado' };
  if (fase.tipo === 'permanente') {
    await runInTenantContext(deps.ds, job.tenantId, (em) =>
      atualizarLog(em, job.idempotencyKey, {
        status: 'falha_permanente',
        erro: 'destino inexistente',
      }),
    );
    return { desfecho: 'falha_permanente', erro: 'destino inexistente' };
  }

  // ---- Fase B: renderiza + envia (fora da transação) -----------------------
  let payload: NotificationPayload;
  if (job.canal === 'email') {
    const email = montarEmailChamado({
      tenantNome: fase.tenant.nome_exibicao,
      corPrimaria: corDe(fase.tenant),
      evento: job.evento,
      numero: fase.chamado.numero,
      titulo: fase.chamado.titulo,
      status: fase.chamado.status,
      prioridade: fase.chamado.prioridade,
      autorNome: fase.autorNome,
      trechoPublico: fase.trechoPublico,
      para: job.contexto.para,
      link: fase.link,
    });
    payload = {
      canal: 'email',
      destino: fase.destino,
      assunto: email.assunto,
      corpoTexto: email.texto,
      corpoHtml: email.html,
    };
  } else {
    const corpo: PayloadWebhook = montarPayloadWebhook({
      webhookTipo: cat.webhook!,
      eventoId: job.eventoNotifId,
      eventoTs: job.eventoTs,
      chamado: {
        id: job.chamadoId,
        numero: fase.chamado.numero,
        titulo: fase.chamado.titulo,
        status: fase.chamado.status,
        prioridade: fase.chamado.prioridade,
        natureza: fase.chamado.natureza,
        sistema_alvo: fase.sistemaNome,
        categoria: fase.categoriaNome,
      },
      autorNome: fase.autorNome,
      trechoPublico: fase.trechoPublico,
      de: job.contexto.de,
      para: job.contexto.para,
      link: fase.link,
      incluiMensagem: job.evento === 'mensagem_publica',
      incluiMudanca: job.evento === 'mudanca_status' || job.evento === 'mudanca_prioridade',
    });
    payload = {
      canal: 'webhook',
      destino: fase.destino,
      corpoJson: corpo,
      webhookEvento: cat.webhook!,
      webhookEventoId: job.eventoNotifId,
    };
  }

  const gateway = deps.registry.obter(job.canal);
  const resultado: EnvioResultado = gateway
    ? await gateway.enviar(payload, fase.canalConfig)
    : { status: 'falha_temporaria', erro: `sem gateway ${job.canal}` };

  // ---- Fase C: atualiza log + circuito de falhas do webhook ----------------
  const posC = await runInTenantContext(deps.ds, job.tenantId, async (em) => {
    await atualizarLog(em, job.idempotencyKey, resultado);
    if (job.canal === 'webhook' && fase.webhookCanalId) {
      if (statusEhSucesso(resultado.status)) {
        await zerarFalhasWebhook(em, fase.webhookCanalId);
        return { adminIds: [] as string[], quando: '' };
      }
      const r = await registrarFalhaWebhook(
        em,
        fase.webhookCanalId,
        resultado.erro ?? 'falha de entrega',
        deps.config.webhook.maxFalhas,
      );
      if (r.desativou) {
        const admins = await em.find(UsuarioSchema, {
          where: { papel: Papel.admin, deleted_at: IsNull() },
        });
        return { adminIds: admins.map((a) => a.id), quando: new Date().toISOString() };
      }
    }
    return { adminIds: [] as string[], quando: '' };
  });

  // ---- Fase D: alerta admin + sinaliza retry -------------------------------
  for (const adminId of posC.adminIds) {
    const alerta: JobAlertaWebhook = {
      especie: 'alerta_webhook',
      idempotencyKey: chaveIdempotenciaTransacional(
        'webhook_desativado',
        `${job.tenantId}|${adminId}|${posC.quando}`,
      ),
      tenantId: job.tenantId,
      canal: 'email',
      destinatarioId: adminId,
      motivo: resultado.erro ?? 'falhas consecutivas de entrega',
    };
    await enfileirarNotificacao(alerta).catch((err) =>
      deps.log('falha ao enfileirar alerta de webhook', { erro: (err as Error).message }),
    );
  }
  if (posC.adminIds.length > 0) {
    deps.log('webhook desativado por falhas consecutivas — admins alertados', {
      tenantId: job.tenantId,
      admins: posC.adminIds.length,
    });
  }

  if (resultado.status === 'falha_temporaria') {
    throw new Error(`falha temporária (${job.canal}): ${resultado.erro ?? ''}`);
  }
  if (resultado.status === 'falha_permanente') {
    return { desfecho: 'falha_permanente', erro: resultado.erro };
  }
  return { desfecho: resultado.status };
}

// ---------------------------------------------------------------------------
// Transacional (convite / reset) e alerta de webhook
// ---------------------------------------------------------------------------

async function processarTransacional(
  job: JobTransacional,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  return enviarEmail(
    deps,
    job.tenantId,
    {
      tenantId: job.tenantId,
      idempotencyKey: job.idempotencyKey,
      chamadoId: null,
      evento: job.tipo,
      canal: 'email',
      destinatarioId: null,
      destino: job.destinatarioEmail,
    },
    (tenant) =>
      montarEmailTransacional({
        tenantNome: tenant.nome_exibicao,
        corPrimaria: corDe(tenant),
        tipo: job.tipo,
        url: job.url,
      }),
    async (em) => {
      const tenant = await em.findOne(TenantSchema, { where: { id: job.tenantId } });
      return tenant ? { destino: job.destinatarioEmail, tenant } : null;
    },
  );
}

async function processarAlertaWebhook(
  job: JobAlertaWebhook,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  return enviarEmail(
    deps,
    job.tenantId,
    {
      tenantId: job.tenantId,
      idempotencyKey: job.idempotencyKey,
      chamadoId: null,
      evento: 'webhook_desativado',
      canal: 'email',
      destinatarioId: job.destinatarioId,
      destino: '',
    },
    (tenant) =>
      montarEmailAlertaWebhook({
        tenantNome: tenant.nome_exibicao,
        corPrimaria: corDe(tenant),
        motivo: job.motivo,
        linkConfig: linkConfig(tenant, deps.config.hostPlataforma),
      }),
    async (em) => {
      const tenant = await em.findOne(TenantSchema, { where: { id: job.tenantId } });
      const admin = await em.findOne(UsuarioSchema, { where: { id: job.destinatarioId } });
      return tenant && admin?.email ? { destino: admin.email, tenant } : null;
    },
  );
}

/**
 * Processa um job da fila `notificacoes` (specs/06 §8). Idempotente por
 * `NotificacaoLog`: reprocessar nunca reenvia um sucesso. `falha_temporaria` é
 * sinalizada por THROW (BullMQ re-tenta com backoff); `falha_permanente` encerra.
 */
export async function processarNotificacao(
  job: JobFila,
  deps: DepsProcessador,
): Promise<ResultadoProcessamento> {
  switch (job.especie) {
    case 'chamado':
      return processarChamado(job, deps);
    case 'transacional':
      return processarTransacional(job, deps);
    case 'alerta_webhook':
      return processarAlertaWebhook(job, deps);
  }
}
