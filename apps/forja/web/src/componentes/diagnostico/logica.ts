import type { DiagnosticoDto, ItemDiagnosticoDto } from '@comum/dto';

/**
 * Regras puras do Diagnóstico (specs/forja/06 §4.10). Cada verificação diz se
 * BLOQUEIA (pipeline, início de execuções, terminal, modo reforçado) ou se é
 * informativa. A tela lê de cima para baixo: o que bloqueia e está vermelho
 * primeiro — é o que explica o banner "Pipeline bloqueado" (06 §1.3).
 */

export type EstadoItem = ItemDiagnosticoDto['estado'];
export type Bloqueio = NonNullable<ItemDiagnosticoDto['bloqueia']>;

export const ROTULO_BLOQUEIO: Record<Bloqueio, string> = {
  pipeline: 'bloqueia o pipeline',
  execucoes: 'bloqueia novas execuções',
  terminal: 'afeta só o Terminal',
  modo_reforcado: 'só com modo reforçado ligado',
};

export const ROTULO_ESTADO_ITEM: Record<EstadoItem, string> = {
  ok: 'ok',
  aviso: 'atenção',
  erro: 'falhou',
  pendente: 'verificando',
};

const PESO_ESTADO: Record<EstadoItem, number> = { erro: 0, aviso: 1, pendente: 2, ok: 3 };
const PESO_BLOQUEIO: Record<Bloqueio | 'nenhum', number> = {
  pipeline: 0,
  execucoes: 1,
  terminal: 2,
  modo_reforcado: 3,
  nenhum: 4,
};

/** Item que de fato impede o trabalho agora (erro em algo que bloqueia pipeline/execuções). */
export function itemBloqueante(i: ItemDiagnosticoDto): boolean {
  return i.estado === 'erro' && (i.bloqueia === 'pipeline' || i.bloqueia === 'execucoes');
}

/** Ordena por severidade e depois pelo alcance do bloqueio; empate mantém a ordem do servidor. */
export function ordenarItens(itens: ItemDiagnosticoDto[]): ItemDiagnosticoDto[] {
  return itens
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const e = PESO_ESTADO[a.item.estado] - PESO_ESTADO[b.item.estado];
      if (e !== 0) return e;
      const bl =
        PESO_BLOQUEIO[a.item.bloqueia ?? 'nenhum'] - PESO_BLOQUEIO[b.item.bloqueia ?? 'nenhum'];
      return bl !== 0 ? bl : a.i - b.i;
    })
    .map((x) => x.item);
}

export interface ResumoDiagnostico {
  bloqueantes: number;
  erros: number;
  avisos: number;
  ok: number;
  pendentes: number;
}

export function resumirDiagnostico(itens: ItemDiagnosticoDto[]): ResumoDiagnostico {
  const r: ResumoDiagnostico = { bloqueantes: 0, erros: 0, avisos: 0, ok: 0, pendentes: 0 };
  for (const i of itens) {
    if (itemBloqueante(i)) r.bloqueantes += 1;
    if (i.estado === 'erro') r.erros += 1;
    else if (i.estado === 'aviso') r.avisos += 1;
    else if (i.estado === 'ok') r.ok += 1;
    else r.pendentes += 1;
  }
  return r;
}

/**
 * Situação da CLI (06 §4.10, 01 §7): a versão encontrada diverge da fixada?
 * Divergir COM smoke aprovado é aceitável (não bloqueia); sem smoke, bloqueia
 * e a tela oferece "aceitar a versão encontrada" (que roda o smoke).
 */
export function situacaoCli(
  v: DiagnosticoDto['versao_cli'],
): 'ausente' | 'igual' | 'diverge_aprovada' | 'diverge_bloqueia' {
  if (!v.encontrada) return 'ausente';
  if (v.encontrada === v.fixada) return 'igual';
  return v.smoke_aprovado ? 'diverge_aprovada' : 'diverge_bloqueia';
}

/**
 * Pré-requisitos do modo reforçado (socat, bwrap, AppArmor userns — 06 §4.8,
 * 05 §4): os itens marcados `modo_reforcado`. O interruptor em Projeto só liga
 * se todos estiverem ok (`failIfUnavailable`, [NV: S1, S6]).
 */
export function prerequisitosModoReforcado(itens: ItemDiagnosticoDto[]): {
  itens: ItemDiagnosticoDto[];
  todosOk: boolean;
  conhecido: boolean;
} {
  const lista = itens.filter((i) => i.bloqueia === 'modo_reforcado');
  return {
    itens: lista,
    todosOk: lista.length > 0 && lista.every((i) => i.estado === 'ok'),
    conhecido: lista.length > 0,
  };
}
