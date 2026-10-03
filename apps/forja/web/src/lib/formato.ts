/**
 * Formatação pura usada pelo shell e pelas telas (specs/forja/06 §1.2).
 * Custos são "equivalente a preço de API", nunca cobrança da assinatura: o
 * rótulo sempre leva "equiv." (03 §2 S4 da pesquisa).
 */

/** Micro-dólares → "US$ 12,40 equiv." (pt-BR). */
export function formatarCustoEquivalente(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  const texto = usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `US$ ${texto} equiv.`;
}

/** 0..1 → "23%" (arredonda para baixo: nunca exagerar folga). */
export function formatarPercentual(fracao: number): string {
  return `${Math.floor(Math.max(0, fracao) * 100)}%`;
}

export type TomCota = 'neutro' | 'ambar' | 'vermelho';

/**
 * Cor do termômetro de cota (06 §1.2): neutro abaixo de (limiar − 10 pp),
 * âmbar até o limiar, vermelho no limiar (freio ativo).
 */
export function tomCota(utilizacao: number, limiar: number): TomCota {
  if (utilizacao >= limiar) return 'vermelho';
  // Epsilon: 0.8 − 0.1 em ponto flutuante é 0.7000000000000001.
  if (utilizacao >= limiar - 0.1 - 1e-9) return 'ambar';
  return 'neutro';
}

/** A cota só é medida quando um `claude` roda; sem medição há 30 min, esmaece. */
export function medicaoRecente(medidoEm: string | null, agora: Date = new Date()): boolean {
  if (!medidoEm) return false;
  const t = Date.parse(medidoEm);
  return Number.isFinite(t) && agora.getTime() - t <= 30 * 60_000;
}

/** "11:52" no fuso local, para "retoma às 11:52". */
export function horaLocal(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
