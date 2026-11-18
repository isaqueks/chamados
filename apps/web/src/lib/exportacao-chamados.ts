import { rotuloEstimativaCusto } from '@chamados/shared';
// Só TIPOS: o gerador (node:zlib) é chamado pela rota, não por este módulo.
import type { LinhaExportacaoFila, LinhaExportacaoPublica } from '@chamados/db';
import type { PlanilhaXlsx } from '@chamados/db/planilha';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from './rotulos';

/**
 * Projeção chamado → linha de planilha (D-045). Puro e testável: a rota de
 * exportação busca as linhas (sob RLS) e entrega a matriz ao gerador `.xlsx`
 * (`@chamados/db/planilha`, D-034). Rótulos humanos em pt-BR, números como
 * números, datas como datas NATIVAS do Excel no fuso do produto.
 *
 * Duas projeções, como duas allowlists: a da EQUIPE (painel) e a PÚBLICA
 * (portal — sem complexidade, responsável, e-mails ou qualquer campo interno;
 * specs/03 §7).
 */

/** Fuso das datas na planilha (o mesmo da UI e dos e-mails). */
export const FUSO_PLANILHA = 'America/Sao_Paulo';

export const COLUNAS_EXPORTACAO_EQUIPE = [
  'Nº',
  'Título',
  'Status',
  'Natureza',
  'Prioridade',
  'Complexidade',
  'Solicitante',
  'E-mail do solicitante',
  'Sistema / categoria',
  'Responsável',
  'Estimativa de custo',
  'Custo final (R$)',
  'Criado em',
  'Atualizado em',
  'Resolvido em',
  'Fechado em',
  'Reaberturas',
] as const;

export const COLUNAS_EXPORTACAO_PUBLICA = [
  'Nº',
  'Título',
  'Status',
  'Natureza',
  'Prioridade',
  'Solicitante',
  'Sistema / categoria',
  'Estimativa de custo',
  'Custo final (R$)',
  'Criado em',
  'Atualizado em',
  'Resolvido em',
  'Fechado em',
  'Reaberturas',
] as const;

/** `numero` (bigint como string) → número na planilha, se couber com segurança. */
function numeroChamado(numero: string): number | string {
  const n = Number(numero);
  return Number.isSafeInteger(n) ? n : numero;
}

export function linhaExportacaoEquipe(c: LinhaExportacaoFila): unknown[] {
  return [
    numeroChamado(c.numero),
    c.titulo,
    ROTULO_STATUS_CHAMADO[c.status],
    ROTULO_NATUREZA[c.natureza],
    ROTULO_PRIORIDADE[c.prioridade],
    c.complexidade ? ROTULO_COMPLEXIDADE[c.complexidade] : null,
    c.solicitante_nome,
    c.solicitante_email,
    c.sistema_nome ?? c.categoria_nome,
    c.operador_nome,
    c.estimativa_custo ? rotuloEstimativaCusto(c.estimativa_custo) : null,
    c.custo_final,
    c.created_at,
    c.updated_at,
    c.resolvido_em,
    c.fechado_em,
    c.reaberto_count,
  ];
}

export function linhaExportacaoPublica(c: LinhaExportacaoPublica): unknown[] {
  return [
    numeroChamado(c.numero),
    c.titulo,
    ROTULO_STATUS_CHAMADO[c.status],
    ROTULO_NATUREZA[c.natureza],
    ROTULO_PRIORIDADE[c.prioridade],
    c.solicitante_eh_voce ? 'Você' : c.solicitante_nome,
    c.sistema_nome ?? c.categoria_nome,
    c.estimativa_custo ? rotuloEstimativaCusto(c.estimativa_custo) : null,
    c.custo_final,
    c.created_at,
    c.updated_at,
    c.resolvido_em,
    c.fechado_em,
    c.reaberto_count,
  ];
}

/** Índice da coluna "Custo final (R$)" → formato moeda. */
function formatosMoeda(colunas: readonly string[]): ('moeda' | undefined)[] {
  return colunas.map((c) => (c === 'Custo final (R$)' ? 'moeda' : undefined));
}

/** Nome da aba: avisa no próprio arquivo quando o recorte passou do teto. */
export function nomeAbaExportacao(truncado: boolean, teto: number): string {
  return truncado ? `Chamados (primeiros ${teto})` : 'Chamados';
}

export function planilhaEquipe(
  itens: LinhaExportacaoFila[],
  truncado: boolean,
  teto: number,
): PlanilhaXlsx {
  return {
    nomeAba: nomeAbaExportacao(truncado, teto),
    colunas: [...COLUNAS_EXPORTACAO_EQUIPE],
    linhas: itens.map(linhaExportacaoEquipe),
    datas: 'data',
    fusoHorario: FUSO_PLANILHA,
    formatos: formatosMoeda(COLUNAS_EXPORTACAO_EQUIPE),
  };
}

export function planilhaPublica(
  itens: LinhaExportacaoPublica[],
  truncado: boolean,
  teto: number,
): PlanilhaXlsx {
  return {
    nomeAba: nomeAbaExportacao(truncado, teto),
    colunas: [...COLUNAS_EXPORTACAO_PUBLICA],
    linhas: itens.map(linhaExportacaoPublica),
    datas: 'data',
    fusoHorario: FUSO_PLANILHA,
    formatos: formatosMoeda(COLUNAS_EXPORTACAO_PUBLICA),
  };
}

const fmtDiaIso = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_PLANILHA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * `chamados-<slug>-<AAAA-MM-DD>.xlsx` (data no fuso do produto). O slug é
 * reduzido a `[a-z0-9-]` (defesa: vai para um cabeçalho HTTP). Recorte maior
 * que o teto → sufixo `-parcial` (a aba também avisa).
 */
export function nomeArquivoExportacao(slug: string, agora: Date, truncado: boolean): string {
  const s =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tenant';
  return `chamados-${s}-${fmtDiaIso.format(agora)}${truncado ? '-parcial' : ''}.xlsx`;
}
