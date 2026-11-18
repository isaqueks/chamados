/**
 * Janela de APROVAÇÃO do cliente (D-042, specs/04 §8.1). Puro e testável.
 *
 * Ao ir para `resolvido`, o chamado abre uma janela de `dias_fechamento_automatico`
 * dias (padrão 7, editável por tenant em /app/config) em que o cliente solicitante
 * APROVA (`resolvido → fechado`, evento `chamado_aprovado`) ou CONTESTA com um
 * motivo (`resolvido → em_atendimento`, evento `chamado_contestado`). Sem resposta
 * até o prazo, o job de manutenção fecha o chamado — APROVAÇÃO TÁCITA (evento
 * `chamado_fechado_auto`, webhook `aprovado` com `forma: 'tacita'`).
 *
 * O prazo é materializado em `chamado.fechar_automaticamente_em` no momento da
 * resolução (mudar a config do tenant depois não altera janelas já abertas).
 */
import { StatusChamado, type TipoEvento } from './enums';

/** Prazo padrão (dias) para o cliente aprovar ou contestar — D-042 (antes: 3). */
export const DIAS_APROVACAO_PADRAO = 7;
/** Faixa aceita na configuração do tenant (UI + config-service). */
export const DIAS_APROVACAO_MIN = 1;
export const DIAS_APROVACAO_MAX = 365;

const MS_DIA = 86_400_000;

/** Forma da aprovação de uma resolução. */
export type FormaAprovacao = 'explicita' | 'tacita';

/**
 * Normaliza o prazo configurado: inteiro em [MIN, MAX]; valor ausente/inválido
 * cai no padrão. Usado na gravação (clamp defensivo) e no cálculo do prazo.
 */
export function normalizarDiasAprovacao(valor: unknown): number {
  if (valor === null || valor === undefined || valor === '') return DIAS_APROVACAO_PADRAO;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(n)) return DIAS_APROVACAO_PADRAO;
  return Math.min(Math.max(Math.trunc(n), DIAS_APROVACAO_MIN), DIAS_APROVACAO_MAX);
}

/** O valor digitado na config é um prazo válido (inteiro em [MIN, MAX])? */
export function diasAprovacaoValido(valor: unknown): boolean {
  const n = typeof valor === 'number' ? valor : Number(valor);
  return Number.isInteger(n) && n >= DIAS_APROVACAO_MIN && n <= DIAS_APROVACAO_MAX;
}

/**
 * Prazo da janela de aprovação: `resolvidoEm + dias`. `dias` passa por
 * `normalizarDiasAprovacao` (um valor fora da faixa no banco não abre janela
 * de 0 ou de 10 anos).
 */
export function calcularPrazoAprovacao(resolvidoEm: Date, dias: unknown): Date {
  return new Date(resolvidoEm.getTime() + normalizarDiasAprovacao(dias) * MS_DIA);
}

/** Evento mínimo para derivar como a resolução foi aprovada. */
export interface EventoAprovacao {
  tipo: TipoEvento;
  created_at: Date | string;
}

/** Situação da aprovação, para exibição (portal e painel). */
export type SituacaoAprovacao =
  | { tipo: 'aguardando'; prazo: Date | null }
  | { tipo: 'aprovado'; forma: FormaAprovacao; em: Date }
  | { tipo: 'fechado_pela_equipe'; em: Date }
  | null;

/**
 * Deriva a situação da janela de aprovação:
 *  - `resolvido` → `aguardando` (com o prazo `fechar_automaticamente_em`);
 *  - `fechado` → o ÚLTIMO evento de fechamento decide: `chamado_aprovado`
 *    (explícita), `chamado_fechado_auto` (tácita) ou `chamado_fechado`
 *    (fechado manualmente pela equipe — não é aprovação do cliente);
 *  - demais status (ou fechado sem evento de fechamento) → `null`.
 */
export function situacaoAprovacao(
  chamado: { status: StatusChamado; fechar_automaticamente_em?: Date | string | null },
  eventos: readonly EventoAprovacao[],
): SituacaoAprovacao {
  if (chamado.status === StatusChamado.resolvido) {
    const p = chamado.fechar_automaticamente_em;
    return { tipo: 'aguardando', prazo: p ? new Date(p) : null };
  }
  if (chamado.status !== StatusChamado.fechado) return null;

  let ultimo: EventoAprovacao | null = null;
  for (const e of eventos) {
    if (
      e.tipo !== 'chamado_aprovado' &&
      e.tipo !== 'chamado_fechado_auto' &&
      e.tipo !== 'chamado_fechado'
    ) {
      continue;
    }
    if (!ultimo || new Date(e.created_at).getTime() >= new Date(ultimo.created_at).getTime()) {
      ultimo = e;
    }
  }
  if (!ultimo) return null;
  const em = new Date(ultimo.created_at);
  if (ultimo.tipo === 'chamado_aprovado') return { tipo: 'aprovado', forma: 'explicita', em };
  if (ultimo.tipo === 'chamado_fechado_auto') return { tipo: 'aprovado', forma: 'tacita', em };
  return { tipo: 'fechado_pela_equipe', em };
}

const FMT_PRAZO = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

/**
 * Prazo legível em pt-BR, no fuso de Brasília (o worker roda em UTC no Docker;
 * sem fuso fixo a data do e-mail poderia "pular" um dia perto da meia-noite).
 * Ex.: "24 de novembro de 2026 às 14:03".
 */
export function formatarPrazoAprovacao(prazo: Date | string): string {
  return FMT_PRAZO.format(new Date(prazo));
}
