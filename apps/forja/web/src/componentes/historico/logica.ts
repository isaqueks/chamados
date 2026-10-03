import type { FiltrosHistoricoDto, LinhaHistoricoDto, WorktreeDto } from '@comum/dto';
import type { EstadoExecucao } from '@comum/estados';

/**
 * Regras puras do Histórico e das Worktrees (specs/forja/06 §4.11; retenção
 * em 02 §9; "Apagar dados deste chamado" em 05 §11).
 */

export type ResultadoHistorico = NonNullable<FiltrosHistoricoDto['resultado']>[number];

export const RESULTADOS: ResultadoHistorico[] = ['concluido', 'descartado', 'cancelado'];

export type Periodo = '7d' | '30d' | '90d' | 'tudo';

export const ROTULO_PERIODO: Record<Periodo, string> = {
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  tudo: 'Todo o período',
};

const DIAS: Record<Exclude<Periodo, 'tudo'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Entrada de `historico_listar` a partir dos filtros da tela. */
export function filtrosHistorico(opcoes: {
  projetoId: string | null;
  periodo: Periodo;
  resultados: ReadonlySet<ResultadoHistorico>;
  agora?: Date;
}): FiltrosHistoricoDto {
  const agora = opcoes.agora ?? new Date();
  const filtros: FiltrosHistoricoDto = {};
  if (opcoes.projetoId) filtros.projeto_id = opcoes.projetoId;
  if (opcoes.periodo !== 'tudo') {
    const de = new Date(agora.getTime() - DIAS[opcoes.periodo] * 24 * 60 * 60 * 1000);
    filtros.de = de.toISOString();
  }
  // Todos marcados = sem filtro (a lista é a mesma e a URL fica curta).
  if (opcoes.resultados.size > 0 && opcoes.resultados.size < RESULTADOS.length) {
    filtros.resultado = RESULTADOS.filter((r) => opcoes.resultados.has(r));
  }
  return filtros;
}

const TERMINAIS: ReadonlySet<EstadoExecucao> = new Set(['concluido', 'descartado', 'cancelado']);

/** "Apagar dados" só vale para execução encerrada (05 §11). */
export function podeApagarDados(estado: EstadoExecucao | null | undefined): boolean {
  return !!estado && TERMINAIS.has(estado);
}

/**
 * O que "Apagar dados deste chamado…" remove e o que mantém (06 §4.11,
 * 05 §11) — a confirmação lista exatamente isto.
 */
export const DADOS_APAGADOS = [
  'Texto e anexos do cliente copiados para a execução (entrada/)',
  'Prints antes/depois (evidencias/)',
  'Eventos brutos da execução (eventos.jsonl)',
  'Transcripts da CLI das sessões desta execução',
  'A worktree, se ainda existir',
] as const;

export const DADOS_MANTIDOS =
  'Fica só o registro mínimo: número do chamado, datas, patch-id, sha do merge e custo.';

/** "62%" ou "—" (taxas chegam de 0 a 1; arredonda para baixo, como o termômetro). */
export function formatarTaxa(taxa: number | null | undefined): string {
  if (taxa === null || taxa === undefined || !Number.isFinite(taxa)) return '—';
  return `${Math.floor(Math.max(0, Math.min(1, taxa)) * 100)}%`;
}

/** 5_400_000 ms → "1 h 30 min"; < 1 min → "< 1 min". */
export function formatarDuracao(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '< 1 min';
  const h = Math.floor(min / 60);
  const resto = min % 60;
  if (h === 0) return `${min} min`;
  return resto ? `${h} h ${resto} min` : `${h} h`;
}

/** Mais recentes primeiro (concluído, senão iniciado). */
export function ordenarHistorico(itens: LinhaHistoricoDto[]): LinhaHistoricoDto[] {
  const chave = (l: LinhaHistoricoDto) => l.concluido_em ?? l.iniciado_em ?? '';
  return [...itens].sort((a, b) => chave(b).localeCompare(chave(a)));
}

/** Órfãs primeiro (é o que se limpa), depois as maiores. */
export function ordenarWorktrees(lista: WorktreeDto[]): WorktreeDto[] {
  return [...lista].sort((a, b) => {
    if (a.orfa !== b.orfa) return a.orfa ? -1 : 1;
    return (b.tamanho_bytes ?? 0) - (a.tamanho_bytes ?? 0);
  });
}

export function resumoWorktrees(lista: WorktreeDto[]): {
  total: number;
  orfas: number;
  bytesOrfas: number;
} {
  let orfas = 0;
  let bytesOrfas = 0;
  for (const w of lista) {
    if (w.orfa) {
      orfas += 1;
      bytesOrfas += w.tamanho_bytes ?? 0;
    }
  }
  return { total: lista.length, orfas, bytesOrfas };
}

/**
 * Ações de uma worktree (06 §4.11). "Retomar" só faz sentido com execução
 * ativa; "Abrir no terminal" precisa saber o projeto (o PTY abre no cwd dela).
 */
export function acoesWorktree(w: WorktreeDto): {
  abrirTerminal: boolean;
  retomar: boolean;
  limpar: boolean;
} {
  const ativa = !!w.execucao_id && !!w.estado_execucao && !TERMINAIS.has(w.estado_execucao);
  return {
    abrirTerminal: !!w.projeto_id && !!w.execucao_id,
    retomar: ativa,
    limpar: !ativa || w.prunable,
  };
}
