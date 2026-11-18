import type { DataSource, EntityManager } from 'typeorm';
import { StatusChamado, StatusExecucaoIA } from '@chamados/shared';
import { ChamadoSchema } from '../entities/chamado';
import { ExecucaoIASchema } from '../entities/execucao-ia';
import { atorSistema, transicionarStatus } from './chamado-service';
import type { HooksChamado } from './auditoria';
import { resolverJobs } from '../notificacoes/dispatcher';
import { chaveIdempotencia } from '../notificacoes/tipos';

/**
 * Manutenção automática do ciclo de vida do chamado (specs/04 §8.1): a
 * APROVAÇÃO TÁCITA (D-042) — o fechamento de chamados `resolvido` cujo prazo
 * para o cliente aprovar ou contestar (`fechar_automaticamente_em`) já venceu
 * sem resposta. É a peça de DADOS que o job `manutencao` do worker orquestra POR
 * TENANT (o worker enumera os tenants ativos e chama esta função dentro de
 * `runInTenantContext` de cada um).
 *
 * A transição `resolvido → fechado` é feita pelo ator `sistema` via
 * `transicionarStatus`, que já: (a) grava o evento `chamado_fechado_auto` com
 * `dados.aprovacao = 'tacita'` (specs/02 §tipo_evento); (b) preenche `fechado_em`
 * e limpa `fechar_automaticamente_em`; (c) traduz o evento em notificações —
 * e-mail ao cliente/responsável e o WEBHOOK `aprovado` (`forma: 'tacita'`) —
 * quando um despachante que captura notificações é injetado nos `hooks` (o
 * worker sempre injeta).
 *
 * IDEMPOTENTE: só toca chamados ainda `resolvido` e vencidos — reexecutar não
 * re-fecha nada (já `fechado`, some do filtro). As linhas são travadas com
 * `FOR UPDATE SKIP LOCKED` (duas varreduras concorrentes nunca fecham — nem
 * notificam — o mesmo chamado duas vezes), além do LOCK global no orquestrador.
 * A ENTREGA do webhook é garantida por `reconciliarWebhooksAprovacaoTacita`.
 */

/** Lista os `id` de tenants `ativo` via a função SECURITY DEFINER (fora de contexto RLS). */
export async function listarTenantsAtivos(ds: DataSource): Promise<string[]> {
  const linhas: Array<{ id: string }> = await ds.query('SELECT id FROM chamados_tenants_ativos()');
  return linhas.map((l) => l.id);
}

export interface ResultadoAutoFechamento {
  /** Ids dos chamados efetivamente fechados (aprovação tácita) nesta varredura. */
  fechados: string[];
  /** Webhooks `aprovado` (tácita) reenfileirados pela reconciliação (D-042). */
  webhooksReconciliados: number;
}

/**
 * Fecha automaticamente — APROVAÇÃO TÁCITA (D-042) — os chamados `resolvido`
 * vencidos do tenant corrente (`em` já escopado por `runInTenantContext`) e
 * reconcilia os webhooks de aprovação tácita das últimas 24 h. Retorna os ids
 * fechados.
 *
 * @param agora Instante de referência (default `new Date()`); parametrizável para testes.
 */
export async function fecharChamadosResolvidosVencidos(
  em: EntityManager,
  tenantId: string,
  hooks?: HooksChamado,
  agora: Date = new Date(),
): Promise<ResultadoAutoFechamento> {
  // SQL cru para o `FOR UPDATE SKIP LOCKED` (RLS vale igual: mesma conexão).
  const vencidos: Array<{ id: string }> = await em.query(
    `SELECT id FROM chamado
      WHERE status = $1 AND fechar_automaticamente_em <= $2 AND deleted_at IS NULL
      ORDER BY fechar_automaticamente_em
      FOR UPDATE SKIP LOCKED`,
    [StatusChamado.resolvido, agora],
  );

  const fechados: string[] = [];
  for (const c of vencidos) {
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
  const webhooksReconciliados = await reconciliarWebhooksAprovacaoTacita(em, tenantId, hooks);
  return { fechados, webhooksReconciliados };
}

/** Janela da reconciliação do webhook de aprovação tácita (D-042). */
export const JANELA_RECONCILIACAO_APROVACAO_MS = 24 * 60 * 60 * 1000;

/**
 * Garantia de ENTREGA do webhook da aprovação tácita (D-042 — requisito
 * explícito: "nenhuma resposta significa aprovação (deve enviar webhook)").
 *
 * O despacho normal é pós-commit e best-effort: se o Redis estiver fora no
 * `flush`, o job se perde. Aqui, a cada varredura, cada `chamado_fechado_auto`
 * com `dados.aprovacao = 'tacita'` das últimas 24 h cujo webhook NÃO tem linha
 * em `notificacao_log` é re-resolvido e republicado. A chave de idempotência é
 * DERIVADA do id do evento (`eventoNotifId = EventoChamado.id`), então:
 *  - job ainda na fila → o `jobId` igual deduplica o enfileiramento;
 *  - job já processado (entregue, aceito ou falha) → há linha no log → pula;
 *  - webhook desativado/sem URL → `resolverJobs` não gera job → nada a fazer.
 * Eventos desta mesma transação (`created_at = now()`) ficam de fora — acabaram
 * de ser despachados. Só eventos com `aprovacao = 'tacita'` (pós-D-042) entram:
 * fechamentos automáticos antigos nunca recebem um `aprovado` retroativo.
 */
export async function reconciliarWebhooksAprovacaoTacita(
  em: EntityManager,
  tenantId: string,
  hooks?: HooksChamado,
  janelaMs: number = JANELA_RECONCILIACAO_APROVACAO_MS,
): Promise<number> {
  const despachante = hooks?.despachante;
  if (!despachante?.capturaNotificacoes) return 0;

  const eventos: Array<{
    id: string;
    chamado_id: string;
    dados: Record<string, unknown> | null;
    created_at: Date;
  }> = await em.query(
    `SELECT id, chamado_id, dados, created_at FROM evento_chamado
      WHERE tipo = 'chamado_fechado_auto' AND dados->>'aprovacao' = 'tacita'
        AND created_at >= now() - ($1::double precision * interval '1 millisecond')
        AND created_at < now()
      ORDER BY created_at`,
    [janelaMs],
  );

  let republicados = 0;
  for (const e of eventos) {
    const chave = chaveIdempotencia({ eventoNotifId: e.id, canal: 'webhook', tenantId });
    const log: Array<{ ok: number }> = await em.query(
      `SELECT 1 AS ok FROM notificacao_log WHERE idempotency_key = $1 LIMIT 1`,
      [chave],
    );
    if (log.length > 0) continue;
    const jobs = await resolverJobs(em, {
      id: e.id,
      ocorrido_em: new Date(e.created_at),
      tipo: 'chamado_fechado_auto',
      chamado_id: e.chamado_id,
      ator_id: null,
      dados: e.dados ?? {},
    });
    for (const job of jobs) {
      if (job.canal !== 'webhook') continue; // e-mail não é reconciliado
      despachante.publicar({ tipo: 'notificacao', job });
      republicados += 1;
    }
  }
  return republicados;
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
