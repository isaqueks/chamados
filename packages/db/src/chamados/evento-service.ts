import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { autorizar, Papel, EVENTOS_INTERNOS, type TipoEvento } from '@chamados/shared';
import { EventoChamadoSchema, type EventoChamado } from '../entities/evento-chamado';
import { ChamadoSchema } from '../entities/chamado';
import type { AtorChamado } from './chamado-service';

/**
 * Timeline de eventos de auditoria (specs/04 §9). Visibilidade por papel: eventos
 * internos (nota interna, complexidade, atribuição de operador, ações `ia_*`)
 * NUNCA aparecem no histórico do cliente. O filtro é feito NO REPOSITÓRIO
 * (query), com o serializer de visibilidade como fonte única da verdade.
 */

export interface EventoView {
  id: string;
  tipo: TipoEvento;
  ator_id: string | null;
  execucao_ia_id: string | null;
  dados: Record<string, unknown>;
  created_at: Date;
}

const TIPOS_INTERNOS: readonly TipoEvento[] = Array.from(EVENTOS_INTERNOS);

/** Lista os eventos de um chamado visíveis ao papel do ator. */
export async function listarEventos(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
): Promise<EventoView[]> {
  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return [];
  if (
    !autorizar(ator, 'chamado', 'ler', {
      cliente_id: chamado.cliente_id,
      tenant_id: chamado.tenant_id,
    })
  ) {
    return [];
  }

  const qb = em
    .createQueryBuilder(EventoChamadoSchema, 'e')
    .where('e.chamado_id = :cid', { cid: chamadoId });

  // Filtro NO REPOSITÓRIO: cliente não vê eventos internos.
  if (ator.papel === Papel.cliente) {
    qb.andWhere('e.tipo NOT IN (:...internos)', { internos: TIPOS_INTERNOS });
  }
  qb.orderBy('e.created_at', 'ASC').addOrderBy('e.id', 'ASC');

  const linhas = await qb.getMany();
  return linhas.map(toView);
}

function toView(e: EventoChamado): EventoView {
  return {
    id: e.id,
    tipo: e.tipo,
    ator_id: e.ator_id,
    execucao_ia_id: e.execucao_ia_id,
    dados: (e.dados ?? {}) as Record<string, unknown>,
    created_at: e.created_at,
  };
}
