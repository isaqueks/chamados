import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import { ORIGEM_CUSTO_RESOLUCAO, type TipoEvento } from '@chamados/shared';
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
  type ContextoNotificacao,
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
  /**
   * Id do `EventoChamado` correspondente. Quando presente, vira o
   * `eventoNotifId` (chaves de idempotência derivadas do evento auditado —
   * reenfileirar o mesmo evento nunca gera outra entrega). Ausente → UUID novo.
   */
  id?: string;
  /** Quando o evento ocorreu (default: agora) — vai em `evento.timestamp`. */
  ocorrido_em?: Date;
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
  // D-043: custo informado NO ATO de resolver é só trilha — o `resolvido` (e-mail
  // e webhook) já leva o valor; notificar de novo seria duplicata.
  if (evento === 'custo_final' && ev.dados?.origem === ORIGEM_CUSTO_RESOLUCAO) return [];

  const chamado: ChamadoMin | null = await em.findOne(ChamadoSchema, {
    where: { id: ev.chamado_id, deleted_at: IsNull() },
  });
  if (!chamado) return [];

  const cat = CATALOGO_NOTIFICACOES[evento];
  const eventoNotifId = ev.id ?? randomUUID();
  const eventoTs = (ev.ocorrido_em ?? new Date()).toISOString();
  const jobs: JobNotificacao[] = [];

  const aprovacao = ev.dados?.aprovacao;
  const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const numero = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const contexto: ContextoNotificacao = {
    autorId: ev.ator_id,
    mensagemId: texto(ev.dados?.mensagem_id),
    de: texto(ev.dados?.de),
    para: texto(ev.dados?.para),
    // D-042: forma da aprovação (só em `aprovado`).
    ...(aprovacao === 'explicita' || aprovacao === 'tacita' ? { aprovacao } : {}),
    // D-043: valores do custo final são números (BRL), não strings.
    ...(evento === 'custo_final'
      ? { custo: { de: numero(ev.dados?.de), para: numero(ev.dados?.para) } }
      : {}),
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
