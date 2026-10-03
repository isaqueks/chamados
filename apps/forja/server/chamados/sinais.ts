import type { RespostaDetalheChamado } from '@chamados/cliente-api';
import type { SinaisChamadoDto } from '../../comum/dto';
import { extrairNotasIa, type NotasIa, type PrIa } from './notas-ia';

/**
 * Sinais da triagem por chamado (specs/forja/07 §3 "Sinais", §4; 02 §4.4
 * `chamado_cache.sinais`; 06 §3.2). Derivados do detalhe em `?formato=markdown`
 * — lidos de forma preguiçosa (concorrência 4) e cacheados por
 * `(id, updated_at)` pela R3; para chamados em voo vale o polling (07 §8).
 *
 * O PR da IA (`ia/chamado-N-*`) NÃO bloqueia o G0 (03 §4.1): vira o sinal
 * `trabalho_existente` para o planejador e força o G1. Só conta a branch cujo
 * número bate com o do chamado — uma nota colada de outro chamado não acende.
 */

/** Forma persistida em `chamado_cache.sinais` (02 §4.4). */
export interface SinaisCache {
  tem_spec_ia: boolean;
  tem_diagnostico_ia: boolean;
  tem_pr_ia: boolean;
  branch_ia: string | null;
}

export interface SinaisDetalhe extends SinaisCache {
  pr_url_ia: string | null;
  ia_silenciada: boolean | null;
  notas: NotasIa;
}

/** PR da IA referente a ESTE chamado (número da branch = número do chamado). */
export function prIaDoChamado(notas: NotasIa, numero: number): PrIa | null {
  const pr = notas.pr?.pr ?? null;
  if (!pr) return null;
  if (pr.numero_na_branch !== null && pr.numero_na_branch !== numero) return null;
  if (!pr.branch && !pr.pr_url) return null;
  return pr;
}

export function sinaisDoDetalhe(detalhe: RespostaDetalheChamado): SinaisDetalhe {
  const notas = extrairNotasIa(detalhe.mensagens);
  const pr = prIaDoChamado(notas, detalhe.chamado.numero);
  return {
    tem_spec_ia: notas.spec !== null,
    tem_diagnostico_ia: notas.diagnostico !== null,
    tem_pr_ia: pr !== null,
    branch_ia: pr?.branch ?? null,
    pr_url_ia: pr?.pr_url ?? null,
    ia_silenciada: detalhe.chamado.ia_silenciada ?? null,
    notas,
  };
}

/** Projeção para a fila (06 §3.2). `cliente_respondeu` vem do polling/snapshot. */
export function sinaisParaDto(
  sinais: (SinaisCache & { ia_silenciada?: boolean | null }) | null,
  extras: { ia_silenciada?: boolean | null; cliente_respondeu?: boolean } = {},
): SinaisChamadoDto {
  return {
    carregado: sinais !== null,
    tem_spec_ia: sinais?.tem_spec_ia ?? false,
    tem_diagnostico_ia: sinais?.tem_diagnostico_ia ?? false,
    tem_pr_ia: sinais?.tem_pr_ia ?? false,
    branch_ia: sinais?.branch_ia ?? null,
    ia_silenciada: extras.ia_silenciada ?? sinais?.ia_silenciada ?? null,
    cliente_respondeu: extras.cliente_respondeu ?? false,
  };
}
