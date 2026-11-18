import { Papel, VisibilidadeMensagem } from './enums';

/**
 * Auto-atribuição por resposta (D-039, specs/04 §7): "qualquer operador que
 * responder um chamado fica responsável por ele". Regra PURA — a camada de
 * serviço (`criarMensagem`) a consulta dentro da transação da mensagem, para
 * valer igual na UI, na API `/api/v1` (MCP, Forja) e em qualquer outro chamador.
 *
 * Atribui quando, e só quando:
 *  - o autor é humano da equipe (`operador` ou `admin`) — `cliente` e `agente_ia`
 *    nunca assumem um chamado por responder;
 *  - a mensagem é `publica` (resposta ao cliente) — nota interna não atribui;
 *  - o autor ainda não é o responsável — se já é, nada acontece (sem evento
 *    duplicado). Havendo OUTRO responsável, o autor o substitui.
 */
export interface EntradaRespostaAtribui {
  autorPapel: Papel;
  autorId: string;
  visibilidade: VisibilidadeMensagem;
  /** `chamado.operador_id` ANTES da mensagem (`null` = não atribuído). */
  operadorAtualId: string | null;
}

export function respostaAtribui(e: EntradaRespostaAtribui): boolean {
  if (e.visibilidade !== VisibilidadeMensagem.publica) return false;
  if (e.autorPapel !== Papel.operador && e.autorPapel !== Papel.admin) return false;
  if (!e.autorId) return false;
  return e.operadorAtualId !== e.autorId;
}

/** Motivo gravado em `dados.motivo` do evento `operador_atribuido` da auto-atribuição. */
export const MOTIVO_ATRIBUICAO_RESPOSTA = 'resposta_publica';
