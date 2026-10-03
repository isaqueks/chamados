import type { CartaoPlanoDto, ClasseCartaoPlano, LinhaLoteDto, LoteResumoDto } from '@comum/dto';
import type { PlanoV1 } from '@comum/contratos';
import type { EstadoExecucao, EstadoLote, GrupoEstadoExecucao } from '@comum/estados';

/**
 * Regras puras da Mesa de planos e do Lote (specs/forja/06 §4.4, §4.5, §5.2).
 *
 * POR QUE a UI recalcula "limpo" se o servidor já manda `classe`: o checkbox
 * de seleção em bloco só pode aparecer em plano limpo (06 §4.4: "só os limpos
 * têm checkbox") — se servidor e UI discordarem, vale o mais restritivo, e a
 * divergência aparece como "precisa de revisão" em vez de entrar num "aprovar
 * limpos" às cegas (03 §4.5 da pesquisa).
 */

// ---------------------------------------------------------------------------
// Mesa de planos
// ---------------------------------------------------------------------------

/**
 * Plano limpo (06 §4.4): confiança `alta`, sem `perguntas_ao_cliente`, sem
 * `schema_banco.altera` (F-14), sem `alertas_seguranca` e sem
 * `decisoes_do_operador`. Plano não implementável nunca é limpo.
 */
export function planoLimpo(
  plano: Pick<
    PlanoV1,
    | 'confianca'
    | 'perguntas_ao_cliente'
    | 'schema_banco'
    | 'alertas_seguranca'
    | 'decisoes_do_operador'
    | 'natureza_confirmada'
  >,
): boolean {
  return (
    plano.natureza_confirmada !== 'nao_implementavel' &&
    plano.confianca === 'alta' &&
    plano.perguntas_ao_cliente.length === 0 &&
    !plano.schema_banco.altera &&
    plano.alertas_seguranca.length === 0 &&
    plano.decisoes_do_operador.length === 0
  );
}

export type FiltroMesa = 'todos' | 'limpos' | 'precisam' | 'planejando';

export const ROTULO_FILTRO_MESA: Record<FiltroMesa, string> = {
  todos: 'Todos',
  limpos: 'Limpos',
  precisam: 'Precisam de você',
  planejando: 'Planejando',
};

/** Estados em que o cartão ainda pede uma decisão na mesa (gate G1/Gdec). */
const ESTADOS_DECISAO_MESA: ReadonlySet<EstadoExecucao> = new Set([
  'aguardando_plano',
  'aguardando_decisao',
]);

const ESTADOS_PLANEJANDO: ReadonlySet<EstadoExecucao> = new Set([
  'na_fila',
  'preparando',
  'planejando',
]);

/** O cartão ainda está na mesa (pede decisão, planeja ou falhou)? */
export function cartaoPendente(c: CartaoPlanoDto): boolean {
  return (
    ESTADOS_DECISAO_MESA.has(c.estado) ||
    ESTADOS_PLANEJANDO.has(c.estado) ||
    c.classe === 'erro' ||
    c.estado === 'falhou'
  );
}

/** Classe efetiva: "limpo" só se o servidor E a regra local concordarem. */
export function classeEfetiva(c: CartaoPlanoDto): ClasseCartaoPlano {
  if (c.classe === 'limpo' && (!c.plano || !planoLimpo(c.plano))) return 'precisa_revisao';
  return c.classe;
}

export function filtroDoCartao(c: CartaoPlanoDto): FiltroMesa {
  const classe = classeEfetiva(c);
  if (classe === 'planejando') return 'planejando';
  if (classe === 'limpo') return 'limpos';
  return 'precisam';
}

export function contarFiltros(cartoes: CartaoPlanoDto[]): Record<FiltroMesa, number> {
  const contagem: Record<FiltroMesa, number> = { todos: 0, limpos: 0, precisam: 0, planejando: 0 };
  for (const c of cartoes) {
    contagem.todos += 1;
    contagem[filtroDoCartao(c)] += 1;
  }
  return contagem;
}

/** Ordem de leitura: o que é perigoso ou bloqueado primeiro, depois limpos, depois planejando. */
const PESO_CLASSE: Record<ClasseCartaoPlano, number> = {
  alerta_seguranca: 0,
  erro: 1,
  decisao: 2,
  schema: 3,
  precisa_revisao: 4,
  limpo: 5,
  planejando: 6,
};

export function filtrarEOrdenar(cartoes: CartaoPlanoDto[], filtro: FiltroMesa): CartaoPlanoDto[] {
  return cartoes
    .filter((c) => filtro === 'todos' || filtroDoCartao(c) === filtro)
    .sort((a, b) => {
      const pa = cartaoPendente(a) ? 0 : 1;
      const pb = cartaoPendente(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const d = PESO_CLASSE[classeEfetiva(a)] - PESO_CLASSE[classeEfetiva(b)];
      return d !== 0 ? d : a.chamado.numero - b.chamado.numero;
    });
}

/** Limpos que ainda aguardam G1 — os únicos selecionáveis em "Aprovar limpos". */
export function limposSelecionaveis(cartoes: CartaoPlanoDto[]): CartaoPlanoDto[] {
  return cartoes.filter((c) => classeEfetiva(c) === 'limpo' && c.estado === 'aguardando_plano');
}

/**
 * Mantém a seleção coerente com a lista atual: ids que deixaram de ser
 * selecionáveis saem; limpos novos entram marcados se `marcarNovos` (o
 * usuário age antes de o lote terminar de planejar, 06 §4.4).
 */
export function reconciliarSelecao(
  selecao: ReadonlySet<string>,
  conhecidos: ReadonlySet<string>,
  cartoes: CartaoPlanoDto[],
  marcarNovos = true,
): Set<string> {
  const validos = new Set(limposSelecionaveis(cartoes).map((c) => c.execucao_id));
  const nova = new Set<string>();
  for (const id of selecao) if (validos.has(id)) nova.add(id);
  if (marcarNovos) for (const id of validos) if (!conhecidos.has(id)) nova.add(id);
  return nova;
}

export function alternar<T>(conjunto: ReadonlySet<T>, valor: T): Set<T> {
  const novo = new Set(conjunto);
  if (novo.has(valor)) novo.delete(valor);
  else novo.add(valor);
  return novo;
}

/** Uma linha por plano para o diálogo "Aprovar limpos" (fallback quando o servidor não manda). */
export function resumoLinhaPlano(c: CartaoPlanoDto): string {
  if (c.resumo_linha) return c.resumo_linha;
  if (!c.plano) return c.chamado.titulo;
  const passos = c.plano.passos.length;
  const arquivos = c.plano.arquivos_previstos.length;
  return `${passos} ${passos === 1 ? 'passo' : 'passos'} · ${arquivos} ${arquivos === 1 ? 'arquivo' : 'arquivos'} · confiança ${c.plano.confianca}`;
}

// ---------------------------------------------------------------------------
// Lote
// ---------------------------------------------------------------------------

/**
 * Estados que ainda NÃO começaram a implementar (06 §4.5: "Cancelar
 * pendentes… lista o que ainda não começou a implementar e preserva o que já
 * está em voo"). Laterais (pausado/cota) contam pelo `estado_anterior`.
 */
const ANTES_DE_IMPLEMENTAR: ReadonlySet<EstadoExecucao> = new Set([
  'na_fila',
  'preparando',
  'planejando',
  'plano_pronto',
  'aguardando_plano',
  'aguardando_decisao',
  'aguardando_cliente_resposta',
]);

const LATERAIS: ReadonlySet<EstadoExecucao> = new Set([
  'pausado_usuario',
  'pausado_cota',
  'interrompido',
]);

export function aindaNaoImplementou(
  estado: EstadoExecucao,
  anterior: EstadoExecucao | null,
): boolean {
  if (ANTES_DE_IMPLEMENTAR.has(estado)) return true;
  if (LATERAIS.has(estado) && anterior) return ANTES_DE_IMPLEMENTAR.has(anterior);
  return false;
}

export function pendentesCancelaveis(linhas: LinhaLoteDto[]): LinhaLoteDto[] {
  return linhas.filter((l) => aindaNaoImplementou(l.execucao.estado, l.execucao.estado_anterior));
}

export const ROTULO_ESTADO_LOTE: Record<EstadoLote, string> = {
  planejando: 'Planejando',
  mesa_de_planos: 'Na mesa de planos',
  implementando: 'Implementando',
  encerrado: 'Encerrado',
  cancelado: 'Cancelado',
};

export function loteAtivo(estado: EstadoLote): boolean {
  return estado !== 'encerrado' && estado !== 'cancelado';
}

const ROTULO_GRUPO: Record<GrupoEstadoExecucao, string> = {
  esperando_recurso: 'na fila',
  trabalhando: 'trabalhando',
  aguardando_voce: 'aguardando você',
  precisa_atencao: 'precisam de atenção',
  aguardando_terceiros: 'aguardando terceiros',
  pausado: 'pausados',
  com_voce: 'com você',
  concluido: 'concluídos',
  encerrado: 'encerrados',
};

const ORDEM_GRUPO: GrupoEstadoExecucao[] = [
  'aguardando_voce',
  'precisa_atencao',
  'trabalhando',
  'com_voce',
  'esperando_recurso',
  'aguardando_terceiros',
  'pausado',
  'concluido',
  'encerrado',
];

/** "2 aguardando você · 3 trabalhando" — só grupos com contagem > 0, na ordem de urgência. */
export function resumoGrupos(
  porGrupo: LoteResumoDto['por_grupo'],
): { grupo: GrupoEstadoExecucao; texto: string }[] {
  return ORDEM_GRUPO.flatMap((g) => {
    const n = porGrupo[g] ?? 0;
    return n > 0 ? [{ grupo: g, texto: `${n} ${ROTULO_GRUPO[g]}` }] : [];
  });
}

/**
 * Quantos itens do lote estão parados na mesa de planos (G1 ou Gdec). Desde
 * FJ-034 a mesa não é obrigatória: o link "Mesa de planos" só aparece com N > 0.
 */
export function naMesaDePlanos(linhas: readonly Pick<LinhaLoteDto, 'execucao'>[]): number {
  return linhas.filter(
    (l) => l.execucao.estado === 'aguardando_plano' || l.execucao.estado === 'aguardando_decisao',
  ).length;
}
