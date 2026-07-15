import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import {
  CanalNotificacaoSchema,
  type CanalNotificacao,
  type ConfigCanal,
} from '../entities/canal-notificacao';
import type { SecretStore } from '../secrets/secret-store';
import { CanalNotificacaoTipo } from './tipos';
import { validarUrlWebhook, WebhookUrlInvalidaError } from './validar-url-webhook';

/**
 * Serviço de `CanalNotificacao` (specs/06 §2-3). Roda sob `runInTenantContext`
 * (RLS). O e-mail da plataforma é criado no provisionamento e está SEMPRE
 * disponível; o webhook é opcional (URL + segredo HMAC no cofre) e desativa-se
 * após N falhas consecutivas (specs/06 §3.2).
 */

/** Lista os canais (não deletados) do tenant. */
export async function listarCanais(em: EntityManager): Promise<CanalNotificacao[]> {
  return em.find(CanalNotificacaoSchema, { where: { deleted_at: IsNull() } });
}

/** Busca um canal por tipo (ou `null`). */
export async function buscarCanal(
  em: EntityManager,
  tipo: CanalNotificacaoTipo,
): Promise<CanalNotificacao | null> {
  return em.findOne(CanalNotificacaoSchema, { where: { tipo, deleted_at: IsNull() } });
}

/** Id do canal de e-mail do tenant (criado no provisionamento). `null` se ausente. */
export async function idCanalEmail(em: EntityManager): Promise<string | null> {
  const c = await buscarCanal(em, CanalNotificacaoTipo.email);
  return c?.id ?? null;
}

/** Visão do webhook para a UI (nunca expõe o segredo — só se há um). */
export interface WebhookView {
  configurado: boolean;
  url: string;
  temSegredo: boolean;
  ativo: boolean;
  falhas_consecutivas: number;
  desativado_em: Date | null;
  ultimo_erro: string | null;
}

/** Projeta o canal webhook para a UI (mascarando o segredo). */
export function toWebhookView(canal: CanalNotificacao | null): WebhookView {
  const url = canal?.config?.url ?? '';
  return {
    configurado: Boolean(canal && url),
    url,
    temSegredo: Boolean(canal?.config?.segredo_ref),
    ativo: canal?.ativo ?? false,
    falhas_consecutivas: canal?.falhas_consecutivas ?? 0,
    desativado_em: canal?.desativado_em ?? null,
    ultimo_erro: canal?.ultimo_erro ?? null,
  };
}

export interface EntradaWebhook {
  url: string;
  /** Novo segredo HMAC (opcional em edição — vazio mantém o atual). */
  segredo?: string;
  ativo: boolean;
}

/**
 * Cria/atualiza o canal webhook do tenant. Persiste o segredo no cofre (envelope
 * encryption) e guarda só a `segredo_ref` no `config`. Salvar manualmente com
 * `ativo=true` ZERA o contador de falhas e limpa a desativação automática
 * (reativação manual após correção — specs/06 §3.2).
 */
export async function salvarWebhook(
  em: EntityManager,
  tenantId: string,
  entrada: EntradaWebhook,
  store: SecretStore,
): Promise<void> {
  // Anti-SSRF (specs/09): valida a URL ANTES de persistir. Fail-closed — uma URL
  // privada/interna/inválida nunca chega ao banco (e, por consequência, nunca é
  // enviada nem "testada", pois o teste lê a URL persistida). URL vazia = limpar.
  const urlLimpa = entrada.url.trim();
  if (urlLimpa !== '') {
    const v = validarUrlWebhook(urlLimpa);
    if (!v.ok) throw new WebhookUrlInvalidaError(v.motivo, v.mensagem);
  }

  const existente = await buscarCanal(em, CanalNotificacaoTipo.webhook);

  // Resolve a referência do segredo: novo → guarda/substitui; vazio → mantém.
  let segredoRef = existente?.config?.segredo_ref ?? null;
  const novoSegredo = entrada.segredo?.trim();
  if (novoSegredo) {
    if (segredoRef) {
      await store.substituir(em, segredoRef, novoSegredo);
    } else {
      segredoRef = await store.guardar(em, tenantId, novoSegredo);
    }
  }

  const config: ConfigCanal = { url: urlLimpa, segredo_ref: segredoRef };

  if (existente) {
    await em.update(
      CanalNotificacaoSchema,
      { id: existente.id },
      {
        config,
        ativo: entrada.ativo,
        // Reativação/salvamento manual reinicia o circuito de falhas.
        ...(entrada.ativo
          ? { falhas_consecutivas: 0, desativado_em: null, ultimo_erro: null }
          : {}),
      },
    );
  } else {
    await em.insert(CanalNotificacaoSchema, {
      tenant_id: tenantId,
      tipo: CanalNotificacaoTipo.webhook,
      config,
      ativo: entrada.ativo,
      falhas_consecutivas: 0,
    });
  }
}

/** Ativa/desativa o webhook manualmente; reativar zera o circuito de falhas. */
export async function definirWebhookAtivo(
  em: EntityManager,
  ativo: boolean,
): Promise<{ ok: boolean }> {
  const canal = await buscarCanal(em, CanalNotificacaoTipo.webhook);
  if (!canal) return { ok: false };
  await em.update(
    CanalNotificacaoSchema,
    { id: canal.id },
    ativo
      ? { ativo: true, falhas_consecutivas: 0, desativado_em: null, ultimo_erro: null }
      : { ativo: false },
  );
  return { ok: true };
}

/** Decifra o segredo HMAC do webhook (para assinar). `null` se não houver. */
export async function lerSegredoWebhook(
  em: EntityManager,
  canal: CanalNotificacao,
  store: SecretStore,
): Promise<string | null> {
  const ref = canal.config?.segredo_ref;
  if (!ref) return null;
  return store.ler(em, ref);
}

/**
 * Registra uma falha de entrega do webhook. Incrementa `falhas_consecutivas`;
 * ao atingir `limite`, DESATIVA o canal automaticamente (specs/06 §3.2). Retorna
 * se acabou de desativar (para disparar o alerta ao admin).
 */
export async function registrarFalhaWebhook(
  em: EntityManager,
  canalId: string,
  erro: string,
  limite: number,
): Promise<{ desativou: boolean; falhas: number }> {
  // Incremento atômico do contador; a releitura usa findOne (robusto sob RLS —
  // `em.query(... RETURNING)` do TypeORM nem sempre devolve as linhas).
  await em.query(
    `UPDATE canal_notificacao
        SET falhas_consecutivas = falhas_consecutivas + 1,
            ultimo_erro = $2,
            updated_at = now()
      WHERE id = $1`,
    [canalId, erro.slice(0, 500)],
  );
  const canal = await em.findOne(CanalNotificacaoSchema, { where: { id: canalId } });
  const falhas = canal?.falhas_consecutivas ?? 0;
  const estavaAtivo = canal?.ativo ?? false;
  if (estavaAtivo && falhas >= limite) {
    await em.update(
      CanalNotificacaoSchema,
      { id: canalId },
      { ativo: false, desativado_em: new Date() },
    );
    return { desativou: true, falhas };
  }
  return { desativou: false, falhas };
}

/** Sucesso de entrega do webhook: zera o contador de falhas (specs/06 §3.2). */
export async function zerarFalhasWebhook(em: EntityManager, canalId: string): Promise<void> {
  await em.update(
    CanalNotificacaoSchema,
    { id: canalId },
    { falhas_consecutivas: 0, ultimo_erro: null },
  );
}
