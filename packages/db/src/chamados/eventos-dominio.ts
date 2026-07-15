import type { GatilhoIA } from '@chamados/shared';

/**
 * Despachante de EVENTOS DE DOMÍNIO — a evolução do seam de auditoria (specs/04
 * §9) para um ponto de extensão de consumidores ASSÍNCRONOS. Enquanto o auditor
 * (`auditoria.ts`) grava a trilha `EventoChamado` DENTRO da transação, o
 * despachante entrega eventos de domínio a consumidores que rodam FORA do ciclo
 * request/response (specs/01 §1.3): a triagem de IA no M6, e as notificações no
 * M9 (que plugam aqui um `Despachante` próprio — ou um composto — sem tocar na
 * lógica das mutações).
 *
 * Contrato: `publicar` é SÍNCRONO e best-effort e NUNCA lança — uma falha de
 * enfileiramento não pode quebrar a mutação do usuário (o efeito é colhido e o
 * fluxo segue). O flush real (I/O de fila) acontece pós-commit, no site de
 * chamada (ex.: `DespachanteFila.flush()` em `fila/triagem-fila.ts`).
 */

/**
 * Evento de domínio emitido por uma mutação de chamado. Discriminado por `tipo`
 * para permitir novos consumidores sem alterar os produtores. M6 emite apenas
 * `triagem_solicitada`; M9 adicionará os eventos de notificação.
 */
export type EventoDominio = {
  tipo: 'triagem_solicitada';
  tenantId: string;
  chamadoId: string;
  /** id da última mensagem que motivou a triagem; `null` na abertura do chamado. */
  ultimaMensagemId: string | null;
  gatilho: GatilhoIA;
};

/** Consumidor de eventos de domínio (best-effort, nunca lança em `publicar`). */
export interface Despachante {
  publicar(ev: EventoDominio): void;
}

/**
 * Despachante no-op (DEFAULT): descarta os eventos. É o comportamento de seeds,
 * smokes e testes que não querem efeitos assíncronos — o enfileiramento só
 * acontece quando um `Despachante` concreto é injetado nos hooks da mutação.
 */
export const despachanteNoop: Despachante = {
  publicar() {
    /* intencionalmente vazio */
  },
};
