import type {
  APublicarDto,
  ChavePassoIntegracao,
  ConcluidoRecenteDto,
  FilaMergeDestinoDto,
  FilaMergeDto,
  ItemFilaMergeDto,
  PendenciaChamadosDto,
} from '@comum/dto';
import type { EstadoItemFilaMerge, PassoOutbox } from '@comum/estados';

/**
 * Agrupamento puro da Fila de merge (specs/forja/06 §4.6; regras em 03 §7–§9).
 *
 * A tela é lida de cima para baixo na ordem do risco: primeiro as faixas que
 * TRAVAM o projeto (sentinela divergente, 05 §4.9; token de schema preso,
 * 03 §7.3), depois a fila serial por projeto × branch de destino (o item em
 * processamento no topo, I-5), as pendências com o Chamados (o merge nunca é
 * refeito, F-16), o que aguarda "Publicado em produção" e os concluídos
 * recentes (FJ-031: sem lembrete de reativar a IA).
 */

export const ROTULO_ESTADO_ITEM: Record<EstadoItemFilaMerge, string> = {
  aguardando: 'Na fila',
  integrando: 'Integrando',
  verificando: 'Reverificando',
  publicando: 'Publicando',
  concluido: 'Concluído',
  devolvido: 'Devolvido',
  conflito: 'Conflito',
};

export const ROTULO_PASSO_INTEGRACAO: Record<ChavePassoIntegracao, string> = {
  integrar: 'integrar',
  reverificar: 'reverificar',
  conferir_patch: 'conferir patch-id',
  avancar_ref: 'avançar a ref',
  push: 'push',
};

export const ROTULO_PASSO_OUTBOX: Record<PassoOutbox, string> = {
  silenciar_ia: 'silenciar a IA',
  atribuir: 'atribuir o chamado',
  nota_inicio: 'nota interna de início',
  pergunta_publica: 'pergunta ao cliente',
  status_aguardando_cliente: 'status aguardando cliente',
  status_em_atendimento: 'status em atendimento',
  nota_interna: 'nota interna',
  mensagem_publica: 'resposta pública',
  status_resolvido: 'status resolvido',
  status_fechado: 'status fechado',
  desatribuir: 'desatribuir',
  reativar_ia: 'reativar a IA',
  nota_descarte: 'nota de descarte',
};

const EM_PROCESSAMENTO: ReadonlySet<EstadoItemFilaMerge> = new Set([
  'integrando',
  'verificando',
  'publicando',
]);

export function itemEmProcessamento(item: Pick<ItemFilaMergeDto, 'estado'>): boolean {
  return EM_PROCESSAMENTO.has(item.estado);
}

export interface FilaVisao {
  chave: string;
  fila: FilaMergeDestinoDto;
  /** No máximo 1 por fila (I-5), sempre no topo. */
  emProcessamento: ItemFilaMergeDto | null;
  /** Ordenados por `ordem`; os únicos reordenáveis. */
  aguardando: ItemFilaMergeDto[];
  /** Conflito/devolvido ainda listados pelo servidor (saem da fila serial). */
  fora: ItemFilaMergeDto[];
  total: number;
}

export type AlertaMerge =
  | {
      tipo: 'sentinela';
      projeto_id: string;
      execucao_id: string;
      numero: number;
      divergencias: string[];
    }
  | { tipo: 'token_schema'; projeto_id: string; execucao_id: string; numero: number };

export interface VisaoFilaMerge {
  alertas: AlertaMerge[];
  filas: FilaVisao[];
  pendencias: PendenciaChamadosDto[];
  aPublicar: APublicarDto[];
  concluidos: ConcluidoRecenteDto[];
  vazia: boolean;
}

export function montarFila(fila: FilaMergeDestinoDto): FilaVisao {
  const ordenados = [...fila.itens].sort((a, b) => a.ordem - b.ordem);
  const emProcessamento = ordenados.find(itemEmProcessamento) ?? null;
  return {
    chave: `${fila.projeto_id}:${fila.branch_destino}`,
    fila,
    emProcessamento,
    aguardando: ordenados.filter((i) => i.estado === 'aguardando'),
    fora: ordenados.filter((i) => i.estado === 'conflito' || i.estado === 'devolvido'),
    total: ordenados.filter((i) => i.estado !== 'concluido').length,
  };
}

/**
 * Monta a visão da tela. `projetoId` = projeto atual do cabeçalho (06 §1.2:
 * a Fila de merge filtra por ele); `null` = todos. Pendências e "a publicar"
 * não trazem o projeto no DTO e por isso nunca são filtradas aqui (o servidor
 * já filtra pela entrada `projeto_id`).
 */
export function montarVisaoFilaMerge(dto: FilaMergeDto, projetoId: string | null): VisaoFilaMerge {
  const doProjeto = (id: string) => projetoId === null || id === projetoId;

  const alertas: AlertaMerge[] = [
    ...dto.sentinelas
      .filter((s) => doProjeto(s.projeto_id))
      .map((s) => ({ tipo: 'sentinela' as const, ...s })),
    ...(dto.token_schema && dto.token_schema.preso && doProjeto(dto.token_schema.projeto_id)
      ? [
          {
            tipo: 'token_schema' as const,
            projeto_id: dto.token_schema.projeto_id,
            execucao_id: dto.token_schema.execucao_id,
            numero: dto.token_schema.numero,
          },
        ]
      : []),
  ];

  const filas = dto.filas
    .filter((f) => doProjeto(f.projeto_id))
    .map(montarFila)
    .sort(
      (a, b) =>
        a.fila.projeto_nome.localeCompare(b.fila.projeto_nome, 'pt-BR') ||
        a.fila.branch_destino.localeCompare(b.fila.branch_destino),
    );

  const pendencias = [...dto.pendencias_chamados].sort((a, b) => {
    if (a.proxima_em === b.proxima_em) return a.numero - b.numero;
    if (a.proxima_em === null) return 1;
    if (b.proxima_em === null) return -1;
    return a.proxima_em.localeCompare(b.proxima_em);
  });

  const aPublicar = [...dto.a_publicar].sort((a, b) => a.numero - b.numero);

  // Mais recentes primeiro.
  const concluidos = [...dto.concluidos_recentes].sort((a, b) =>
    b.concluido_em.localeCompare(a.concluido_em),
  );

  const vazia =
    alertas.length === 0 &&
    filas.every((f) => f.total === 0) &&
    pendencias.length === 0 &&
    aPublicar.length === 0 &&
    concluidos.length === 0;

  return { alertas, filas, pendencias, aPublicar, concluidos, vazia };
}

/**
 * Nova `ordem` para mover um item aguardando uma posição para cima/baixo
 * (troca com o vizinho). `null` = movimento impossível (borda ou item fora da
 * parte reordenável — o item em processamento nunca se move).
 */
export function novaOrdem(
  aguardando: ItemFilaMergeDto[],
  itemId: string,
  direcao: 'subir' | 'descer',
): number | null {
  const i = aguardando.findIndex((x) => x.id === itemId);
  if (i < 0) return null;
  const j = direcao === 'subir' ? i - 1 : i + 1;
  const vizinho = aguardando[j];
  return vizinho ? vizinho.ordem : null;
}

/** Remove da seleção o que já não está em "a publicar" (o SSE pode ter mudado a lista). */
export function selecaoValida(
  selecao: ReadonlySet<string>,
  aPublicar: APublicarDto[],
): Set<string> {
  const ids = new Set(aPublicar.map((a) => a.execucao_id));
  return new Set([...selecao].filter((id) => ids.has(id)));
}
