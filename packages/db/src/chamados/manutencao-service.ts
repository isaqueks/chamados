import type { DataSource, EntityManager } from 'typeorm';
import { LessThanOrEqual, IsNull } from 'typeorm';
import { StatusChamado, StatusExecucaoIA } from '@chamados/shared';
import { ChamadoSchema, type Chamado } from '../entities/chamado';
import { ExecucaoIASchema } from '../entities/execucao-ia';
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

// --- Redes de segurança contra estado preso (D-016, specs/05 §8) -------------

export interface ExecucaoOrfa {
  id: string;
  chamado_id: string | null;
}

/**
 * Marca como `falhou` (erro `execucao_orfa`) as `ExecucaoIA` presas em
 * `na_fila`/`executando` há mais de `limiarMs` — sobras de um processo de worker
 * MORTO no meio da execução (kill/crash: nenhum handler de fila roda; o
 * incidente de 2026-07-16 deixou uma `executando` eterna). Retorna as execuções
 * marcadas para o orquestrador (worker) escalonar os chamados afetados.
 *
 * O limiar deve exceder com folga a execução legítima mais longa (mapa e
 * triagem têm timeout de 10 min cada + git sync/PR) — default do worker: 30 min.
 */
export async function marcarExecucoesOrfas(
  em: EntityManager,
  limiarMs: number,
  agora: Date = new Date(),
): Promise<ExecucaoOrfa[]> {
  const corte = new Date(agora.getTime() - limiarMs);
  const res = await em
    .createQueryBuilder()
    .update(ExecucaoIASchema)
    .set({ status: StatusExecucaoIA.falhou, erro: 'execucao_orfa', finalizado_em: () => 'now()' })
    .where('status IN (:...presos)', {
      presos: [StatusExecucaoIA.na_fila, StatusExecucaoIA.executando],
    })
    // `iniciado_em` cobre `executando`; `created_at` cobre `na_fila` (nunca iniciou).
    .andWhere('COALESCE(iniciado_em, created_at) < :corte', { corte })
    .returning(['id', 'chamado_id'])
    .execute();
  return res.raw as ExecucaoOrfa[];
}

/**
 * Chamados presos em `em_triagem` sem NENHUMA execução de IA ativa (`na_fila`/
 * `executando`) e sem atualização há mais de `limiarMs` — tipicamente um job de
 * triagem perdido (Redis fora no flush pós-commit da criação) ou uma
 * compensação de falha que também falhou. O orquestrador (worker) exclui os que
 * ainda têm job pendente na fila e escala o restante para humano ("o chamado
 * nunca fica preso sem responsável" — specs/05 §8).
 */
export async function listarChamadosEncalhadosEmTriagem(
  em: EntityManager,
  limiarMs: number,
  agora: Date = new Date(),
): Promise<string[]> {
  const corte = new Date(agora.getTime() - limiarMs);
  const linhas: Array<{ id: string }> = await em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('c.id', 'id')
    .where('c.status = :st', { st: StatusChamado.em_triagem })
    .andWhere('c.updated_at < :corte', { corte })
    .andWhere('c.deleted_at IS NULL')
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM execucao_ia e
        WHERE e.chamado_id = c.id AND e.status IN (:...ativos))`,
      { ativos: [StatusExecucaoIA.na_fila, StatusExecucaoIA.executando] },
    )
    .getRawMany();
  return linhas.map((l) => l.id);
}
