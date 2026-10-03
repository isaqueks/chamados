import { Complexidade, Natureza, Prioridade, StatusChamado } from '@chamados/shared';
import type { FiltrosFilaDto, LinhaFilaDto, PreCondicaoDto } from '@comum/dto';
import { estadoAtivo } from '@comum/estados';

/**
 * Regras puras da Fila (specs/forja/06 §4.1). Ficam fora dos componentes para
 * serem testadas sem DOM: o que a coluna "Forja" mostra em cada linha, quando o
 * botão Implementar age, quais linhas entram na seleção do lote e a ordenação
 * default (prioridade desc + atualização recente, igual à fila do Chamados).
 *
 * O servidor já calcula as pré-condições (03 §4.1, 07); aqui só se decide a
 * APRESENTAÇÃO — a UI nunca reinventa a regra, ela lê `pre_condicoes`.
 */

/** Status default do filtro (06 §4.1): `em_atendimento` + `aguardando_cliente`. */
export const STATUS_PADRAO_FILA: StatusChamado[] = [
  StatusChamado.em_atendimento,
  StatusChamado.aguardando_cliente,
];

export const OPCOES_STATUS = Object.values(StatusChamado);
export const OPCOES_NATUREZA = Object.values(Natureza);
export const OPCOES_PRIORIDADE = Object.values(Prioridade);
export const OPCOES_COMPLEXIDADE = Object.values(Complexidade);

const PESO_PRIORIDADE: Record<Prioridade, number> = {
  urgente: 3,
  alta: 2,
  media: 1,
  baixa: 0,
};

const STATUS_TERMINAIS: ReadonlySet<StatusChamado> = new Set([
  StatusChamado.resolvido,
  StatusChamado.fechado,
  StatusChamado.cancelado,
]);

const STATUS_TRIAGEM: ReadonlySet<StatusChamado> = new Set([
  StatusChamado.novo,
  StatusChamado.em_triagem,
]);

/** Ordenação default: prioridade desc, depois atualização remota mais recente. */
export function ordenarLinhas(linhas: readonly LinhaFilaDto[]): LinhaFilaDto[] {
  return [...linhas].sort((a, b) => {
    const p = PESO_PRIORIDADE[b.chamado.prioridade] - PESO_PRIORIDADE[a.chamado.prioridade];
    if (p !== 0) return p;
    const ta = a.chamado.atualizado_em_remoto ? Date.parse(a.chamado.atualizado_em_remoto) : 0;
    const tb = b.chamado.atualizado_em_remoto ? Date.parse(b.chamado.atualizado_em_remoto) : 0;
    return tb - ta;
  });
}

/**
 * Filtro em memória: a complexidade é filtrada no cliente até existir D-036 L3
 * (06 §4.1), e a busca/"só implementáveis" também valem aqui para a resposta
 * ser imediata enquanto o servidor relê.
 */
export function filtrarEmMemoria(
  linhas: readonly LinhaFilaDto[],
  filtros: Pick<FiltrosFilaDto, 'complexidade' | 'busca' | 'so_implementaveis'>,
): LinhaFilaDto[] {
  const busca = (filtros.busca ?? '').trim().toLowerCase().replace(/^#/, '');
  const complexidades = filtros.complexidade?.length ? new Set(filtros.complexidade) : null;
  return linhas.filter((l) => {
    if (complexidades && (!l.chamado.complexidade || !complexidades.has(l.chamado.complexidade))) {
      return false;
    }
    if (filtros.so_implementaveis && !l.implementavel && !l.execucao) return false;
    if (busca) {
      const numero = String(l.chamado.numero);
      if (!numero.startsWith(busca) && !l.chamado.titulo.toLowerCase().includes(busca)) {
        return false;
      }
    }
    return true;
  });
}

/** Pré-condições que faltam (cada uma vira um motivo legível no tooltip/diálogo). */
export function preCondicoesFaltando(linha: LinhaFilaDto): PreCondicaoDto[] {
  return linha.pre_condicoes.filter((p) => !p.ok);
}

/** `aguardando_cliente`: o servidor marca a pré-condição de status com `exige_confirmacao`. */
export function exigeConfirmacaoAguardandoCliente(linha: LinhaFilaDto): boolean {
  return linha.pre_condicoes.some((p) => p.ok && p.exige_confirmacao === true);
}

export type CelulaForja =
  | { tipo: 'implementar' }
  | { tipo: 'indisponivel'; motivos: string[] }
  | { tipo: 'triagem' }
  | { tipo: 'terminal' }
  | { tipo: 'em_voo'; href: string }
  | { tipo: 'aprovar'; href: string };

/**
 * O que a coluna "Forja" mostra (wireframe 06 §4.1): execução ativa → estado +
 * [Abrir] (ou [Aprovar] em `aguardando_aprovacao`); triagem → "— (triagem)";
 * status terminal → linha esmaecida; senão Implementar, habilitado ou com os
 * motivos de indisponibilidade.
 */
export function celulaForja(linha: LinhaFilaDto): CelulaForja {
  const ex = linha.execucao;
  if (ex && estadoAtivo(ex.estado)) {
    if (ex.estado === 'aguardando_aprovacao') {
      return { tipo: 'aprovar', href: `/execucoes/${ex.id}/aprovacao` };
    }
    return { tipo: 'em_voo', href: `/execucoes/${ex.id}` };
  }
  if (STATUS_TERMINAIS.has(linha.chamado.status)) return { tipo: 'terminal' };
  if (STATUS_TRIAGEM.has(linha.chamado.status) && !linha.implementavel) return { tipo: 'triagem' };
  if (linha.implementavel) return { tipo: 'implementar' };
  const motivos = preCondicoesFaltando(linha)
    .map((p) => p.motivo)
    .filter((m): m is string => !!m);
  return { tipo: 'indisponivel', motivos: motivos.length ? motivos : ['pré-condição faltando'] };
}

export function linhaEsmaecida(linha: LinhaFilaDto): boolean {
  return celulaForja(linha).tipo === 'terminal';
}

/** Só linhas implementáveis e sem execução ativa entram na seleção do lote. */
export function selecionavel(linha: LinhaFilaDto): boolean {
  return celulaForja(linha).tipo === 'implementar';
}

/** Remove da seleção o que deixou de ser selecionável (ex.: após o SSE). */
export function podarSelecao(
  selecao: ReadonlySet<string>,
  linhas: readonly LinhaFilaDto[],
): Set<string> {
  const validos = new Set(linhas.filter(selecionavel).map((l) => l.chamado.chamado_id));
  return new Set([...selecao].filter((id) => validos.has(id)));
}

export function alternarSelecao(selecao: ReadonlySet<string>, id: string): Set<string> {
  const nova = new Set(selecao);
  if (nova.has(id)) nova.delete(id);
  else nova.add(id);
  return nova;
}

/** "Selecionar todos" alterna entre todos os selecionáveis visíveis e nenhum. */
export function alternarTodos(
  selecao: ReadonlySet<string>,
  linhas: readonly LinhaFilaDto[],
): Set<string> {
  const ids = linhas.filter(selecionavel).map((l) => l.chamado.chamado_id);
  const todos = ids.length > 0 && ids.every((id) => selecao.has(id));
  return todos ? new Set() : new Set(ids);
}

/** Rótulo de opção com contador (regra D-030 do Chamados, 08 §4.4). */
export function rotuloComContagem(rotulo: string, contagem: number | undefined): string {
  return contagem === undefined ? rotulo : `${rotulo} (${contagem})`;
}

/** Texto do botão do dropdown: "Status", "Status: Em atendimento", "Status (2)". */
export function rotuloFiltro(
  nome: string,
  selecionados: readonly string[],
  rotular: (v: string) => string,
): string {
  if (selecionados.length === 0) return nome;
  if (selecionados.length === 1) return `${nome}: ${rotular(selecionados[0]!)}`;
  return `${nome} (${selecionados.length})`;
}

/** "sincronizado há 40 s" / "há 3 min" / "há 2 h". */
export function haQuantoTempo(iso: string | null, agora: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((agora.getTime() - t) / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}
