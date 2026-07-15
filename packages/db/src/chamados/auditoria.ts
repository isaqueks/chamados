import type { EntityManager } from 'typeorm';
import type { TipoEvento } from '@chamados/shared';
import { EventoChamadoSchema } from '../entities/evento-chamado';
import { despachanteNoop, type Despachante } from './eventos-dominio';
import { despacharNotificacoes } from '../notificacoes/dispatcher';

/**
 * Auditoria de `EventoChamado` (specs/04 §9, specs/02). TODA mutação relevante do
 * chamado (criação, transição de status, prioridade, natureza, complexidade,
 * atribuição, mensagens, anexos) grava uma linha APPEND-ONLY nesta trilha, dentro
 * da MESMA transação da mutação — via o auditor default `gravarEvento`.
 *
 * O ponto de extensão (`HooksChamado.auditar`) segue disponível para injetar um
 * auditor alternativo (ex.: no-op em testes, ou um coletor). Sem hook, escreve.
 */
export interface EventoChamadoPendente {
  /** Tipo canônico do evento (enum `tipo_evento` — specs/02). */
  tipo: TipoEvento;
  chamado_id: string;
  /** Ator (usuário/agente_ia). `null` = sistema (jobs automáticos). */
  ator_id: string | null;
  /** Referência à `ExecucaoIA` que originou o evento (M6+). */
  execucao_ia_id?: string | null;
  /** Payload (ex.: `{ de, para }`, `{ mensagem_id }`, `{ operador_novo }`). */
  dados?: Record<string, unknown>;
}

/** Callback de auditoria executado dentro da transação da mutação. */
export type Auditar = (em: EntityManager, ev: EventoChamadoPendente) => Promise<void> | void;

/**
 * Auditor default: grava o evento em `evento_chamado`. O `tenant_id` vem do
 * contexto RLS corrente (`app.current_tenant`), garantindo coerência com a policy
 * (a linha só é aceita para o tenant da transação — WITH CHECK).
 */
export const gravarEvento: Auditar = async (em, ev) => {
  const linhas: Array<{ tenant: string | null }> = await em.query(
    "SELECT current_setting('app.current_tenant', true) AS tenant",
  );
  const tenant = linhas[0]?.tenant;
  if (!tenant) {
    throw new Error(
      'EventoChamado: app.current_tenant não definido — auditoria exige runInTenantContext.',
    );
  }
  await em.insert(EventoChamadoSchema, {
    tenant_id: tenant,
    chamado_id: ev.chamado_id,
    tipo: ev.tipo,
    ator_id: ev.ator_id,
    execucao_ia_id: ev.execucao_ia_id ?? null,
    dados: ev.dados ?? {},
  });
};

/** No-op explícito (para testes/cenários que desejam desligar a auditoria). */
export const auditarNoop: Auditar = () => {
  /* intencionalmente vazio */
};

/** Hooks opcionais passados às mutações de chamado. */
export interface HooksChamado {
  /** Auditor síncrono (grava `EventoChamado` na transação). Default: `gravarEvento`. */
  auditar?: Auditar;
  /**
   * Despachante de eventos de DOMÍNIO (triagem de IA no M6, notificações no M9).
   * Default: no-op — só há efeito assíncrono quando um despachante é injetado.
   */
  despachante?: Despachante;
}

/**
 * Resolve o auditor efetivo. Um `auditar` explícito nos hooks SEMPRE vence (tests
 * que desligam a auditoria). Sem override: grava o `EventoChamado` e, quando o
 * despachante injetado captura notificações (M9), TRADUZ o evento em notificações
 * e as publica (buffer) — tudo dentro da transação da mutação. A tradução é
 * BEST-EFFORT: uma falha nela NUNCA quebra a mutação (a gravação da trilha, sim,
 * continua obrigatória). Despachantes sem `capturaNotificacoes` (ex.: só triagem)
 * não pagam a resolução.
 */
export function auditorDe(hooks?: HooksChamado): Auditar {
  if (hooks?.auditar) return hooks.auditar;
  const despachante = hooks?.despachante;
  if (!despachante?.capturaNotificacoes) return gravarEvento;
  return async (em, ev) => {
    await gravarEvento(em, ev);
    try {
      await despacharNotificacoes(em, ev, despachante);
    } catch {
      /* best-effort: resolução de notificação não derruba a mutação já auditada */
    }
  };
}

/** Resolve o despachante efetivo: o injetado nos hooks ou o no-op. */
export function despacharDe(hooks?: HooksChamado): Despachante {
  return hooks?.despachante ?? despachanteNoop;
}
