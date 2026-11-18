/**
 * Estimativa de custo e custo final do chamado (D-043, specs/04 §3.4).
 *
 * Fonte ÚNICA das faixas (rótulo + limites em BRL) e das regras de valor em
 * dinheiro: o domínio, a API, a UI, os e-mails e o webhook usam estas funções —
 * nenhuma tela reescreve "R$ 100 a R$ 200" à mão. Módulo puro (sem I/O).
 *
 * Valores em REAIS (BRL) como `number` com no máximo 2 casas; no banco vivem em
 * `numeric(12,2)` (o driver devolve string — ver `custoDoBanco`).
 */
import { EstimativaCusto } from './enums';

export interface FaixaEstimativaCusto {
  /** Limite inferior em BRL (inclusive). */
  min: number;
  /** Limite superior em BRL; `null` = sem teto ("acima de"). */
  max: number | null;
  /** Faixa por extenso, sem o código (ex.: "R$ 100 a R$ 200"). */
  faixa: string;
}

/**
 * Faixas FIXAS da plataforma (pedido do usuário, D-043). Não são configuráveis
 * por tenant nesta versão — evolução registrada no ADR. Os limites se tocam
 * (100 fecha A e abre B) porque são faixas de ESTIMATIVA, não de cobrança.
 */
export const FAIXAS_ESTIMATIVA_CUSTO: Record<EstimativaCusto, FaixaEstimativaCusto> = {
  [EstimativaCusto.A]: { min: 50, max: 100, faixa: 'R$ 50 a R$ 100' },
  [EstimativaCusto.B]: { min: 100, max: 200, faixa: 'R$ 100 a R$ 200' },
  [EstimativaCusto.C]: { min: 200, max: 400, faixa: 'R$ 200 a R$ 400' },
  [EstimativaCusto.D]: { min: 400, max: 600, faixa: 'R$ 400 a R$ 600' },
  [EstimativaCusto.E]: { min: 600, max: null, faixa: 'acima de R$ 600' },
  [EstimativaCusto.I]: { min: 0, max: 0, faixa: 'Isento (R$ 0)' },
};

/** Ordem de exibição nos seletores (A…E e, por último, Isento). */
export const ORDEM_ESTIMATIVA_CUSTO: readonly EstimativaCusto[] = [
  EstimativaCusto.A,
  EstimativaCusto.B,
  EstimativaCusto.C,
  EstimativaCusto.D,
  EstimativaCusto.E,
  EstimativaCusto.I,
];

/** O valor é um código válido de estimativa? */
export function ehEstimativaCusto(v: unknown): v is EstimativaCusto {
  return typeof v === 'string' && (Object.values(EstimativaCusto) as string[]).includes(v);
}

/** Só a faixa ("R$ 100 a R$ 200", "acima de R$ 600", "Isento (R$ 0)"). */
export function faixaEstimativaCusto(e: EstimativaCusto): string {
  return FAIXAS_ESTIMATIVA_CUSTO[e].faixa;
}

/**
 * Rótulo canônico com o código — UI, e-mail e webhook: "B · R$ 100 a R$ 200",
 * "E · acima de R$ 600", "Isento (R$ 0)" (o código `I` não acrescenta nada ao
 * leitor e não aparece no rótulo).
 */
export function rotuloEstimativaCusto(e: EstimativaCusto): string {
  if (e === EstimativaCusto.I) return FAIXAS_ESTIMATIVA_CUSTO[e].faixa;
  return `${e} · ${FAIXAS_ESTIMATIVA_CUSTO[e].faixa}`;
}

// ---------------------------------------------------------------------------
// Custo final (valor arbitrário em BRL)
// ---------------------------------------------------------------------------

/**
 * `dados.origem` do evento `custo_final_definido` quando o custo veio NO ATO de
 * resolver: o evento fica só na trilha/timeline — não notifica nem dispara o
 * webhook `custo_final_definido` (o webhook `resolvido` já leva o valor).
 */
export const ORIGEM_CUSTO_RESOLUCAO = 'resolucao';

/** Teto do `numeric(12,2)`: 10 dígitos inteiros + 2 decimais. */
export const CUSTO_FINAL_MAX = 9_999_999_999.99;

export type MotivoValorBrl =
  'vazio' | 'formato_invalido' | 'negativo' | 'casas_decimais' | 'acima_do_limite';

export type ResultadoValorBrl = { ok: true; valor: number } | { ok: false; motivo: MotivoValorBrl };

/** Mensagens pt-BR dos motivos (formulários e API). */
export const MENSAGEM_VALOR_BRL: Record<MotivoValorBrl, string> = {
  vazio: 'Informe o valor.',
  formato_invalido: 'Valor inválido. Use o formato 1.234,56.',
  negativo: 'O custo não pode ser negativo.',
  casas_decimais: 'Use no máximo 2 casas decimais (centavos).',
  acima_do_limite: 'Valor acima do limite permitido.',
};

/** Tem no máximo 2 casas decimais (tolerante ao ponto flutuante)? */
function ateDuasCasas(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

/** Valida um número já decodificado (JSON da API ou resultado do parse). */
export function validarCustoFinal(v: number): ResultadoValorBrl {
  if (!Number.isFinite(v)) return { ok: false, motivo: 'formato_invalido' };
  if (v < 0) return { ok: false, motivo: 'negativo' };
  if (!ateDuasCasas(v)) return { ok: false, motivo: 'casas_decimais' };
  if (v > CUSTO_FINAL_MAX) return { ok: false, motivo: 'acima_do_limite' };
  return { ok: true, valor: Math.round(v * 100) / 100 };
}

const RE_MILHAR_PONTO = /^\d{1,3}(\.\d{3})+$/;

/**
 * Interpreta um valor digitado em pt-BR: "1.234,56", "1234,56", "150", "R$ 99,9",
 * "0". Regras:
 *  - com VÍRGULA, ela é o separador decimal e os pontos são de milhar;
 *  - sem vírgula, pontos em grupos de 3 ("1.500", "1.000.000") são milhar; um
 *    único ponto com 1–2 casas ("150.5") é aceito como decimal (colado de
 *    sistema/planilha em formato inglês);
 *  - "R$", espaços (inclusive NBSP) são ignorados; sinal de menos → `negativo`;
 *  - mais de 2 casas → `casas_decimais`; acima de `CUSTO_FINAL_MAX` → `acima_do_limite`.
 */
export function parsearValorBrl(entrada: string): ResultadoValorBrl {
  let s = entrada.replace(/R\$/gi, '').replace(/[\s\u00a0]/g, '');
  if (s === '') return { ok: false, motivo: 'vazio' };
  let negativo = false;
  if (s.startsWith('-')) {
    negativo = true;
    s = s.slice(1);
  }
  if (s === '' || !/^[\d.,]+$/.test(s)) return { ok: false, motivo: 'formato_invalido' };

  let normal: string;
  if (s.includes(',')) {
    const partes = s.split(',');
    if (partes.length !== 2) return { ok: false, motivo: 'formato_invalido' };
    const [inteiro, dec] = partes as [string, string];
    if (inteiro.includes('.') && !RE_MILHAR_PONTO.test(inteiro)) {
      return { ok: false, motivo: 'formato_invalido' };
    }
    if (dec === '' || !/^\d+$/.test(dec)) return { ok: false, motivo: 'formato_invalido' };
    normal = `${inteiro.replace(/\./g, '') || '0'}.${dec}`;
  } else if (s.includes('.')) {
    if (RE_MILHAR_PONTO.test(s)) {
      normal = s.replace(/\./g, '');
    } else if (/^\d+\.\d+$/.test(s)) {
      normal = s;
    } else {
      return { ok: false, motivo: 'formato_invalido' };
    }
  } else {
    normal = s;
  }

  const casas = normal.includes('.') ? normal.split('.')[1]!.length : 0;
  if (casas > 2) return { ok: false, motivo: 'casas_decimais' };
  const v = Number(normal);
  if (!Number.isFinite(v)) return { ok: false, motivo: 'formato_invalido' };
  if (negativo && v !== 0) return { ok: false, motivo: 'negativo' };
  return validarCustoFinal(v);
}

/**
 * Formata em BRL pt-BR ("R$ 1.234,56"). Espaço comum no lugar do NBSP do
 * `Intl` — o mesmo texto serve a HTML, e-mail texto e testes.
 */
export function formatarBrl(valor: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(valor)
    .replace(/\u00a0/g, ' ');
}

/** Valor para o campo de edição ("1234,56" — sem "R$" nem milhar). */
export function valorParaCampo(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  return valor.toFixed(2).replace('.', ',');
}

/** `numeric(12,2)` do driver pg (string) → número (ou `null`). */
export function custoDoBanco(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Número → literal decimal para o `numeric(12,2)` ("150.00"). */
export function custoParaBanco(v: number | null): string | null {
  return v === null ? null : v.toFixed(2);
}

/**
 * Complemento da linha de TIMELINE dos eventos de custo (painel e portal —
 * D-043): "(sem estimativa → B · R$ 100 a R$ 200)", "(R$ 150,00 → R$ 180,00)",
 * "(R$ 150,00)", "(removido)". `null` para outros tipos de evento.
 */
export function detalheEventoCusto(tipo: string, dados: unknown): string | null {
  const d = (dados ?? {}) as { de?: unknown; para?: unknown };
  if (tipo === 'estimativa_custo_alterada') {
    const nome = (v: unknown) =>
      ehEstimativaCusto(v) ? rotuloEstimativaCusto(v) : 'sem estimativa';
    return `(${nome(d.de)} → ${nome(d.para)})`;
  }
  if (tipo === 'custo_final_definido') {
    const de = typeof d.de === 'number' ? formatarBrl(d.de) : null;
    const para = typeof d.para === 'number' ? formatarBrl(d.para) : null;
    if (!para) return de ? `(${de} → removido)` : '(removido)';
    return de ? `(${de} → ${para})` : `(${para})`;
  }
  return null;
}
