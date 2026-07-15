import type { EntityManager } from 'typeorm';

/**
 * ⚠️ SEAM DE AUDITORIA (M3) — PREENCHER EM M4.
 *
 * Toda mutação relevante do chamado (criação, transição de status, prioridade,
 * natureza, complexidade, atribuição) DEVE gerar um `EventoChamado` append-only
 * (specs/04 §9, specs/02 "EventoChamado"). Essa entidade e sua tabela são
 * escopo de M4 — aqui NÃO criamos a tabela. Em vez disso, as mutações chamam
 * este hook (no-op por padrão), deixando o ponto de extensão pronto: M4 injeta
 * um `Auditar` que grava a linha de `evento_chamado` dentro da MESMA transação.
 *
 * `tipo` é um string livre por ora; M4 o tipa com o enum `tipo_evento` de
 * specs/02 (`chamado_criado`, `status_alterado`, `prioridade_alterada`, ...).
 */
export interface EventoChamadoPendente {
  /** Tipo do evento (vira o enum `tipo_evento` em M4). */
  tipo: string;
  chamado_id: string;
  /** Ator (usuário/agente_ia). `null` = sistema. */
  ator_id: string | null;
  /** Payload (ex.: `{ de, para }`, `{ operador_anterior, operador_novo }`). */
  dados?: Record<string, unknown>;
}

/** Callback de auditoria executado dentro da transação da mutação. */
export type Auditar = (em: EntityManager, ev: EventoChamadoPendente) => Promise<void> | void;

/** Hooks opcionais passados às mutações de chamado. */
export interface HooksChamado {
  auditar?: Auditar;
}

/** Implementação no-op default (M4 substitui por gravação em `evento_chamado`). */
export const auditarNoop: Auditar = () => {
  // Intencionalmente vazio (M3). M4 grava o EventoChamado aqui.
};

/** Resolve o auditor efetivo (o injetado ou o no-op). */
export function auditorDe(hooks?: HooksChamado): Auditar {
  return hooks?.auditar ?? auditarNoop;
}
