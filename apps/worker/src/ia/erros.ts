/**
 * Erros de encerramento por LIMITE de execução (specs/05 §8). O provider honra
 * os limites operacionais de `AIProviderInput.limites` (timeout/budget/maxTurnos)
 * e sinaliza o motivo ao pipeline lançando um destes erros; o pipeline os mapeia
 * para `ExecucaoIA.status = falhou` com `erro = 'timeout' | 'budget_excedido'`.
 *
 * NÃO confundir com o guardrail de negócio ("nunca merge/deploy sem aprovação
 * humana"), que vive no PIPELINE, fora do provider (specs/01 §4.1, specs/05).
 */

/** Timeout de execução excedido (specs/05 §8 → erro = 'timeout'). */
export class ErroProviderTimeout extends Error {
  readonly codigo = 'timeout';
  constructor(msg = 'timeout') {
    super(msg);
    this.name = 'ErroProviderTimeout';
  }
}

/** Orçamento de custo/tokens excedido (specs/05 §8 → erro = 'budget_excedido'). */
export class ErroProviderBudget extends Error {
  readonly codigo = 'budget_excedido';
  constructor(msg = 'budget_excedido') {
    super(msg);
    this.name = 'ErroProviderBudget';
  }
}

/** Traduz um erro qualquer no `erro` textual gravado em `ExecucaoIA` (specs/05 §8). */
export function motivoErro(err: unknown): string {
  if (err instanceof ErroProviderTimeout) return 'timeout';
  if (err instanceof ErroProviderBudget) return 'budget_excedido';
  if (err instanceof Error && err.message) return err.message;
  return 'erro_desconhecido';
}
