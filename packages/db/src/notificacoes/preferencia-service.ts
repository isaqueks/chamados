import type { EntityManager } from 'typeorm';
import { PreferenciaNotificacaoSchema } from '../entities/preferencia-notificacao';
import {
  CATALOGO_NOTIFICACOES,
  eventosDoPapel,
  eObrigatorio,
  type EventoNotificavel,
  type PapelDestinatario,
} from './tipos';

/**
 * Preferências de notificação por usuário (specs/06 §7). A regra de resolução:
 *  - evento OBRIGATÓRIO para o papel → SEMPRE habilitado (ignora a preferência);
 *  - senão, existe linha → usa `habilitado`; AUSENTE → default `true` (o papel
 *    recebe por padrão os eventos que o afetam — specs/06 §7).
 */

/** Resolve se um (usuário × evento × canal) está habilitado (efetivo). */
export async function preferenciaHabilitada(
  em: EntityManager,
  usuarioId: string,
  evento: EventoNotificavel,
  canalId: string,
  papel: PapelDestinatario,
): Promise<boolean> {
  if (eObrigatorio(evento, papel)) return true;
  const linha = await em.findOne(PreferenciaNotificacaoSchema, {
    where: { usuario_id: usuarioId, evento, canal_id: canalId },
  });
  return linha ? linha.habilitado : true;
}

/** Item da matriz de preferências exibida ao usuário. */
export interface PreferenciaItem {
  evento: EventoNotificavel;
  rotulo: string;
  descricao: string;
  obrigatorio: boolean;
  habilitado: boolean;
}

/**
 * Lista as preferências (efetivas) do usuário para o canal de e-mail, prontas
 * para a UI. Obrigatórias vêm `habilitado=true` e travadas (`obrigatorio=true`).
 */
export async function listarPreferenciasUsuario(
  em: EntityManager,
  usuarioId: string,
  papel: PapelDestinatario,
  canalEmailId: string,
): Promise<PreferenciaItem[]> {
  const eventos = eventosDoPapel(papel);
  const linhas = await em.find(PreferenciaNotificacaoSchema, {
    where: { usuario_id: usuarioId, canal_id: canalEmailId },
  });
  const mapa = new Map(linhas.map((l) => [l.evento, l.habilitado]));

  return eventos.map((evento) => {
    const obrigatorio = eObrigatorio(evento, papel);
    const cat = CATALOGO_NOTIFICACOES[evento];
    return {
      evento,
      rotulo: cat.rotulo,
      descricao: cat.descricao,
      obrigatorio,
      habilitado: obrigatorio ? true : (mapa.get(evento) ?? true),
    };
  });
}

export type MotivoPreferencia = 'obrigatorio' | 'evento_invalido';
export type ResultadoPreferencia = { ok: true } | { ok: false; motivo: MotivoPreferencia };

/**
 * Define uma preferência (upsert). Recusa desabilitar evento OBRIGATÓRIO para o
 * papel (specs/06 §7). Habilitar é sempre permitido.
 */
export async function definirPreferencia(
  em: EntityManager,
  tenantId: string,
  usuarioId: string,
  evento: EventoNotificavel,
  canalId: string,
  habilitado: boolean,
  papel: PapelDestinatario,
): Promise<ResultadoPreferencia> {
  if (!(evento in CATALOGO_NOTIFICACOES)) return { ok: false, motivo: 'evento_invalido' };
  if (!habilitado && eObrigatorio(evento, papel)) {
    return { ok: false, motivo: 'obrigatorio' };
  }
  await em.query(
    `INSERT INTO preferencia_notificacao
       (tenant_id, usuario_id, evento, canal_id, habilitado)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, usuario_id, evento, canal_id)
       DO UPDATE SET habilitado = EXCLUDED.habilitado, updated_at = now()`,
    [tenantId, usuarioId, evento, canalId, habilitado],
  );
  return { ok: true };
}
