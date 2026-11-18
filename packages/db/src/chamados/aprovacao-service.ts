import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { autorizar, Papel, StatusChamado, VisibilidadeMensagem } from '@chamados/shared';
import { ChamadoSchema } from '../entities/chamado';
import type { HooksChamado } from './auditoria';
import { transicionarStatus, type AtorChamado, type MotivoTransicionar } from './chamado-service';
import { criarMensagem, type MotivoMensagem } from './mensagem-service';
import type { DocRico } from './rich-text';

/**
 * Janela de APROVAÇÃO do cliente (D-042, specs/04 §8.1). Enquanto o chamado está
 * `resolvido`, o cliente SOLICITANTE (ler ≠ agir — D-037: colegas do tenant leem,
 * mas não aprovam nem contestam):
 *
 *  - APROVA: `resolvido → fechado` (evento `chamado_aprovado`, `fechado_em`);
 *  - CONTESTA: publica o MOTIVO como mensagem pública; o `criarMensagem` já reabre
 *    (`resolvido → em_atendimento` pelo próprio cliente — evento
 *    `chamado_contestado`, `reaberto_count++`) e re-dispara a triagem como
 *    qualquer resposta do cliente (D-017; a IA silenciada descarta o job).
 *
 * Sem resposta até `fechar_automaticamente_em`, o job de manutenção fecha
 * (aprovação TÁCITA — `fecharChamadosResolvidosVencidos`).
 *
 * As duas funções são açúcar com mensagens de erro claras para a UI; a regra
 * vive na máquina de estados + `transicionarStatus` (a API `/api/v1` chega ao
 * mesmo lugar por `POST /status` e `POST /mensagens`).
 */

export type MotivoAprovacao =
  | MotivoTransicionar
  /** O chamado não está `resolvido` (não há janela de aprovação aberta). */
  | 'fora_da_janela';

export type ResultadoAprovacao = { ok: true } | { ok: false; motivo: MotivoAprovacao };

export type MotivoContestacao = MotivoAprovacao | MotivoMensagem;

export type ResultadoContestacao =
  { ok: true; mensagem_id: string } | { ok: false; motivo: MotivoContestacao };

/**
 * Pré-condições comuns: chamado existe (sob RLS — outro tenant = inexistente), o
 * ator é CLIENTE e SOLICITANTE (operador/admin fecham ou reabrem pelas ações
 * próprias; aprovar/contestar é do cliente) e o chamado está `resolvido`.
 */
async function preCondicoes(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
): Promise<{ ok: true } | { ok: false; motivo: MotivoAprovacao }> {
  const c = await em.findOne(ChamadoSchema, { where: { id: chamadoId, deleted_at: IsNull() } });
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (
    ator.papel !== Papel.cliente ||
    !autorizar(ator, 'chamado', 'mudar_status', {
      cliente_id: c.cliente_id,
      tenant_id: c.tenant_id,
    })
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (c.status !== StatusChamado.resolvido) return { ok: false, motivo: 'fora_da_janela' };
  return { ok: true };
}

/** O cliente solicitante APROVA a resolução (`resolvido → fechado`). */
export async function aprovarResolucao(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
  hooks?: HooksChamado,
): Promise<ResultadoAprovacao> {
  const pre = await preCondicoes(em, ator, chamadoId);
  if (!pre.ok) return pre;
  const r = await transicionarStatus(em, ator, chamadoId, StatusChamado.fechado, {}, hooks);
  return r.ok ? { ok: true } : { ok: false, motivo: r.motivo };
}

/**
 * O cliente solicitante CONTESTA a resolução: o motivo (obrigatório) vira
 * mensagem pública e o chamado volta a `em_atendimento`.
 */
export async function contestarResolucao(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
  motivo: string | DocRico,
  hooks?: HooksChamado,
): Promise<ResultadoContestacao> {
  const pre = await preCondicoes(em, ator, chamadoId);
  if (!pre.ok) return pre;
  if (typeof motivo === 'string' && motivo.trim().length === 0) {
    return { ok: false, motivo: 'motivo_obrigatorio' };
  }

  const m = await criarMensagem(
    em,
    ator,
    { chamado_id: chamadoId, visibilidade: VisibilidadeMensagem.publica, corpo: motivo },
    hooks,
  );
  if (!m.ok)
    return { ok: false, motivo: m.motivo === 'corpo_vazio' ? 'motivo_obrigatorio' : m.motivo };

  // Defesa: o `criarMensagem` reabre por conta própria; confirma que a
  // contestação aconteceu (se não, a transação inteira é desfeita pelo chamador
  // ao receber erro — nada de mensagem "solta" num chamado ainda resolvido).
  const depois = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
  if (depois?.status !== StatusChamado.em_atendimento) {
    throw new Error('contestarResolucao: a mensagem não reabriu o chamado (rollback)');
  }
  return { ok: true, mensagem_id: m.id };
}
