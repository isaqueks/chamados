import type { TelemetriaIA } from '@chamados/shared';

/**
 * Erros de encerramento por LIMITE de execução (specs/05 §8). O provider honra
 * os limites operacionais de `AIProviderInput.limites` (timeout/budget/maxTurnos)
 * e sinaliza o motivo ao pipeline lançando um destes erros; o pipeline os mapeia
 * para `ExecucaoIA.status = falhou` com `erro = 'timeout' | 'budget_excedido' |
 * 'max_turnos'`.
 *
 * Telemetria PARCIAL (D-033): uma execução que falha por limite já consumiu
 * tokens/dinheiro — antes isso sumia (custo `NULL` em 20 mapeamentos falhos de
 * produção). O provider anexa ao erro o que apurou até o corte; o pipeline grava
 * via `falharExecucao(..., { telemetriaParcial })`.
 *
 * NÃO confundir com o guardrail de negócio ("nunca merge/deploy sem aprovação
 * humana"), que vive no PIPELINE, fora do provider (specs/01 §4.1, specs/05).
 */

/** Telemetria apurada até o momento da falha (qualquer campo pode faltar). */
export type TelemetriaParcial = Partial<TelemetriaIA>;

/** Base dos erros de limite: carrega a telemetria parcial da execução cortada. */
export class ErroProviderLimite extends Error {
  readonly telemetriaParcial: TelemetriaParcial | undefined;
  constructor(msg: string, telemetriaParcial?: TelemetriaParcial) {
    super(msg);
    this.name = 'ErroProviderLimite';
    this.telemetriaParcial = telemetriaParcial;
  }
}

/** Timeout de execução excedido (specs/05 §8 → erro = 'timeout'). */
export class ErroProviderTimeout extends ErroProviderLimite {
  readonly codigo = 'timeout';
  constructor(telemetriaParcial?: TelemetriaParcial, msg = 'timeout') {
    super(msg, telemetriaParcial);
    this.name = 'ErroProviderTimeout';
  }
}

/** Orçamento de custo/tokens excedido (specs/05 §8 → erro = 'budget_excedido'). */
export class ErroProviderBudget extends ErroProviderLimite {
  readonly codigo = 'budget_excedido';
  constructor(telemetriaParcial?: TelemetriaParcial, msg = 'budget_excedido') {
    super(msg, telemetriaParcial);
    this.name = 'ErroProviderBudget';
  }
}

/**
 * Máximo de turnos atingido SEM saída utilizável (specs/05 §8 → erro =
 * 'max_turnos'). No mapeamento, o provider antes tenta um turno de CONCLUSÃO
 * (D-033); só lança isto se nem assim houver resumo.
 */
export class ErroProviderMaxTurnos extends ErroProviderLimite {
  readonly codigo = 'max_turnos';
  constructor(telemetriaParcial?: TelemetriaParcial, msg = 'max_turnos') {
    super(msg, telemetriaParcial);
    this.name = 'ErroProviderMaxTurnos';
  }
}

/** Traduz um erro qualquer no `erro` textual gravado em `ExecucaoIA` (specs/05 §8). */
export function motivoErro(err: unknown): string {
  if (err instanceof ErroProviderTimeout) return 'timeout';
  if (err instanceof ErroProviderBudget) return 'budget_excedido';
  if (err instanceof ErroProviderMaxTurnos) return 'max_turnos';
  if (err instanceof Error && err.message) return err.message;
  return 'erro_desconhecido';
}

/** Telemetria parcial carregada por um erro de limite (ou `undefined`). */
export function telemetriaDoErro(err: unknown): TelemetriaParcial | undefined {
  return err instanceof ErroProviderLimite ? err.telemetriaParcial : undefined;
}
