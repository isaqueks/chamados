import type { DataSource, EntityManager } from 'typeorm';
import { LessThanOrEqual, IsNull } from 'typeorm';
import { StatusChamado } from '@chamados/shared';
import { ChamadoSchema, type Chamado } from '../entities/chamado';
import { atorSistema, transicionarStatus } from './chamado-service';
import type { HooksChamado } from './auditoria';

/**
 * Manutenção automática do ciclo de vida do chamado (specs/04 §8.1): o
 * auto-fechamento de chamados `resolvido` cujo prazo (`fechar_automaticamente_em`)
 * já venceu. É a peça de DADOS que o job `manutencao` do worker orquestra POR
 * TENANT (o worker enumera os tenants ativos e chama esta função dentro de
 * `runInTenantContext` de cada um).
 *
 * A transição `resolvido → fechado` é feita pelo ator `sistema` via
 * `transicionarStatus`, que já: (a) grava o evento `chamado_fechado_auto`
 * (specs/02 §tipo_evento); (b) preenche `fechado_em` e limpa
 * `fechar_automaticamente_em`; (c) dispara a notificação de fechamento ao cliente
 * (quando um despachante que captura notificações é injetado nos `hooks`).
 *
 * IDEMPOTENTE: só toca chamados ainda `resolvido` e vencidos — reexecutar não
 * re-fecha nada (já `fechado`, some do filtro). Concorrência entre instâncias do
 * worker é tratada por LOCK no orquestrador (ver worker `manutencao`).
 */

/** Lista os `id` de tenants `ativo` via a função SECURITY DEFINER (fora de contexto RLS). */
export async function listarTenantsAtivos(ds: DataSource): Promise<string[]> {
  const linhas: Array<{ id: string }> = await ds.query('SELECT id FROM chamados_tenants_ativos()');
  return linhas.map((l) => l.id);
}

export interface ResultadoAutoFechamento {
  /** Ids dos chamados efetivamente fechados nesta varredura. */
  fechados: string[];
}

/**
 * Fecha automaticamente os chamados `resolvido` vencidos do tenant corrente
 * (`em` já escopado por `runInTenantContext`). Retorna os ids fechados.
 *
 * @param agora Instante de referência (default `new Date()`); parametrizável para testes.
 */
export async function fecharChamadosResolvidosVencidos(
  em: EntityManager,
  tenantId: string,
  hooks?: HooksChamado,
  agora: Date = new Date(),
): Promise<ResultadoAutoFechamento> {
  const vencidos = await em.find(ChamadoSchema, {
    where: {
      status: StatusChamado.resolvido,
      fechar_automaticamente_em: LessThanOrEqual(agora),
      deleted_at: IsNull(),
    },
    select: { id: true },
  });

  const fechados: string[] = [];
  for (const c of vencidos as Array<Pick<Chamado, 'id'>>) {
    const r = await transicionarStatus(
      em,
      atorSistema(tenantId),
      c.id,
      StatusChamado.fechado,
      { motivo: 'auto_fechamento_prazo' },
      hooks,
    );
    if (r.ok) fechados.push(c.id);
  }
  return { fechados };
}
