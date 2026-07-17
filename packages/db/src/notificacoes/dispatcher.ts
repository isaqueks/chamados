import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import type { TipoEvento } from '@chamados/shared';
import { ChamadoSchema } from '../entities/chamado';
import { CanalNotificacaoSchema } from '../entities/canal-notificacao';
import { PreferenciaNotificacaoSchema } from '../entities/preferencia-notificacao';
import type { Despachante } from '../chamados/eventos-dominio';
import {
  CATALOGO_NOTIFICACOES,
  CanalNotificacaoTipo,
  chaveIdempotencia,
  eObrigatorio,
  defaultDoEvento,
  eventoNotificavelDe,
  type EventoNotificavel,
  type JobNotificacao,
  type PapelDestinatario,
} from './tipos';

/**
 * NotificationDispatcher (specs/06 §2, §6): traduz um evento de auditoria
 * (`EventoChamado`) nos JOBS de notificação por (destinatário × canal) + webhook,
 * resolvendo destinatários e aplicando preferências (§7). É a ÚNICA peça que
 * conhece a regra de "quem recebe o quê". Roda DENTRO da transação da mutação
 * (via o seam de auditoria) e é BEST-EFFORT: nunca deve quebrar a mutação.
 *
 * NÃO faz I/O de fila — devolve os jobs; o enfileiramento real acontece pós-commit
 * (`DespachanteNotificacoes.flush`) para não criar job fantasma em rollback.
 */

/** Forma estrutural do evento de auditoria (evita ciclo com `auditoria.ts`). */
export interface EventoAuditavel {
  tipo: TipoEvento;
  chamado_id: string;
  ator_id: string | null;
  dados?: Record<string, unknown>;
}

interface ChamadoMin {
  tenant_id: string;
  cliente_id: string;
  operador_id: string | null;
}

function papelDoSlot(slot: PapelDestinatario): PapelDestinatario {
  return slot;
}

/** Verifica a preferência de e-mail; ausência de linha = default do CATÁLOGO (§7). */
async function emailHabilitado(
  em: EntityManager,
  usuarioId: string,
  evento: EventoNotificavel,
  papel: PapelDestinatario,
  canalEmailId: string | null,
): Promise<boolean> {
  if (eObrigatorio(evento, papel)) return true; // obrigatório ignora preferência (§7).
  if (!canalEmailId) return defaultDoEvento(evento); // sem canal materializado → default.
  const linha = await em.findOne(PreferenciaNotificacaoSchema, {
    where: { usuario_id: usuarioId, evento, canal_id: canalEmailId },
  });
  return linha ? linha.habilitado : defaultDoEvento(evento);
}

/**
 * Resolve os jobs de notificação para um evento de auditoria. Retorna `[]` quando
 * o evento não é notificável (nota interna, complexidade, ações internas da IA…).
 */
export async function resolverJobs(
  em: EntityManager,
  ev: EventoAuditavel,
): Promise<JobNotificacao[]> {
  const evento = eventoNotificavelDe(ev.tipo);
  if (!evento) return [];

  // Mensagem: só a PÚBLICA notifica (defesa extra além do tipo do evento).
  if (evento === 'mensagem_publica' && ev.dados?.visibilidade === 'interna') return [];

  const chamado: ChamadoMin | null = await em.findOne(ChamadoSchema, {
    where: { id: ev.chamado_id, deleted_at: IsNull() },
  });
  if (!chamado) return [];

  const cat = CATALOGO_NOTIFICACOES[evento];
  const eventoNotifId = randomUUID();
  const eventoTs = new Date().toISOString();
  const jobs: JobNotificacao[] = [];

  const contexto = {
    autorId: ev.ator_id,
    mensagemId: (ev.dados?.mensagem_id as string | undefined) ?? null,
    de: (ev.dados?.de as string | undefined) ?? null,
    para: (ev.dados?.para as string | undefined) ?? null,
  };

  // --- Destinatários humanos (e-mail) --------------------------------------
  const canalEmail = await em.findOne(CanalNotificacaoSchema, {
    where: { tipo: CanalNotificacaoTipo.email, deleted_at: IsNull() },
  });
  const canalEmailId = canalEmail?.id ?? null;

  const jaAdicionados = new Set<string>();
  for (const slot of cat.destinatarios) {
    const usuarioId = slot === 'cliente' ? chamado.cliente_id : chamado.operador_id;
    if (!usuarioId || jaAdicionados.has(usuarioId)) continue;

    // Autor não é notificado da própria ação, EXCETO confirmações (abertura/reabertura).
    if (usuarioId === ev.ator_id && !cat.confirmacaoAutor) continue;

    const papel = papelDoSlot(slot);
    if (!(await emailHabilitado(em, usuarioId, evento, papel, canalEmailId))) continue;

    jaAdicionados.add(usuarioId);
    jobs.push({
      especie: 'chamado',
      idempotencyKey: chaveIdempotencia({
        eventoNotifId,
        canal: 'email',
        destinatarioId: usuarioId,
        tenantId: chamado.tenant_id,
      }),
      tenantId: chamado.tenant_id,
      eventoNotifId,
      eventoTs,
      evento,
      chamadoId: ev.chamado_id,
      canal: 'email',
      destinatarioId: usuarioId,
      contexto,
    });
  }

  // --- Webhook (canal por tenant, dispara uma vez por evento) ---------------
  if (cat.webhook) {
    const canalWebhook = await em.findOne(CanalNotificacaoSchema, {
      where: { tipo: CanalNotificacaoTipo.webhook, deleted_at: IsNull() },
    });
    if (canalWebhook && canalWebhook.ativo && canalWebhook.config?.url) {
      jobs.push({
        especie: 'chamado',
        idempotencyKey: chaveIdempotencia({
          eventoNotifId,
          canal: 'webhook',
          tenantId: chamado.tenant_id,
        }),
        tenantId: chamado.tenant_id,
        eventoNotifId,
        eventoTs,
        evento,
        chamadoId: ev.chamado_id,
        canal: 'webhook',
        destinatarioId: null,
        contexto,
      });
    }
  }

  return jobs;
}

/**
 * Traduz o evento e PUBLICA cada job no despachante (buffer). Best-effort: uma
 * falha de resolução NUNCA quebra a mutação — o chamador (auditor) engole erros.
 */
export async function despacharNotificacoes(
  em: EntityManager,
  ev: EventoAuditavel,
  despachante: Despachante,
): Promise<void> {
  const jobs = await resolverJobs(em, ev);
  for (const job of jobs) {
    despachante.publicar({ tipo: 'notificacao', job });
  }
}
