import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  EstimativaCusto,
  situacaoDoStatus,
  rotuloEstimativaCusto,
  type SituacaoChamado,
} from '@chamados/shared';
// Só TIPOS de @chamados/db: este módulo roda também no client (filtros.tsx).
import type {
  FiltrosFila,
  FiltroEstimativaCusto,
  OrdenacaoFila,
  CampoOrdenacaoFila,
  PeriodoFila,
} from '@chamados/db';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from './rotulos';

/**
 * Estado da fila `/app/chamados` ↔ URL (D-045). Fonte ÚNICA de parse/validação
 * dos parâmetros, da URL canônica (links compartilháveis), dos chips de filtros
 * ativos e da ordenação — usada pela página (server), pela barra de filtros
 * (client) e pela rota de exportação. Puro: nada de I/O nem de `@chamados/db`
 * em runtime (só tipos).
 *
 * Parâmetros: `q`, `situacao`, `status`, `prioridade`, `responsavel`
 * (`meus` | `nenhum` | UUID), `natureza`, `complexidade`, `estimativa`
 * (A–E, I, `sem_estimativa`), `solicitante` (UUID), `sistema`/`categoria`
 * (UUID — o "alvo", mutuamente exclusivos), `periodo` (`criado`|`atualizado`) +
 * `de`/`ate` (AAAA-MM-DD), `ordem` + `dir`, `pagina`, `por`. Legado aceito:
 * `atribuicao=meus|nao_atribuidos` (links do dashboard); `cursor` é ignorado.
 */

export type ParamsBrutos = URLSearchParams | Record<string, string | string[] | undefined>;

/** Responsável: qualquer (`''`), atribuídos a mim, sem responsável ou um operador (UUID). */
export type ResponsavelFila = '' | 'meus' | 'nenhum' | (string & {});

export const TAMANHOS_PAGINA = [25, 50, 100] as const;
export type TamanhoPagina = (typeof TAMANHOS_PAGINA)[number];
export const TAMANHO_PAGINA_PADRAO: TamanhoPagina = 25;

export const CAMPOS_ORDENACAO: readonly CampoOrdenacaoFila[] = [
  'atualizado',
  'criado',
  'prioridade',
  'numero',
];

export const ROTULO_CAMPO_ORDENACAO: Record<CampoOrdenacaoFila, string> = {
  atualizado: 'Atualizado',
  criado: 'Criado',
  prioridade: 'Prioridade',
  numero: 'Número',
};

/** Sentido de cada ordenação em palavras (seletor de ordenação e subtítulo). */
export const ROTULO_DIRECAO_ORDENACAO: Record<CampoOrdenacaoFila, { desc: string; asc: string }> = {
  atualizado: { desc: 'mais recentes', asc: 'mais antigos' },
  criado: { desc: 'mais recentes', asc: 'mais antigos' },
  prioridade: { desc: 'mais urgentes', asc: 'menos urgentes' },
  numero: { desc: 'maior primeiro', asc: 'menor primeiro' },
};

/** "Atualizado · mais recentes" / "Relevância" (ordem `null` = relevância da busca). */
export function descreverOrdem(o: OrdenacaoFila | null): string {
  if (!o) return 'Relevância';
  return `${ROTULO_CAMPO_ORDENACAO[o.campo]} · ${ROTULO_DIRECAO_ORDENACAO[o.campo][o.direcao]}`;
}

const CRITERIO_ORDENACAO: Record<CampoOrdenacaoFila, string> = {
  atualizado: 'última atualização',
  criado: 'data de criação',
  prioridade: 'prioridade',
  numero: 'número',
};

/** Frase para o subtítulo: "última atualização (mais recentes primeiro)" / "relevância". */
export function fraseOrdem(o: OrdenacaoFila | null): string {
  if (!o) return 'relevância';
  const dir = ROTULO_DIRECAO_ORDENACAO[o.campo][o.direcao];
  return `${CRITERIO_ORDENACAO[o.campo]} (${dir.endsWith('primeiro') ? dir : `${dir} primeiro`})`;
}

export interface EstadoFila {
  busca: string;
  /** Situação EFETIVA (D-030: padrão `abertos`; `status`/`q` podem mudá-la). */
  situacao: SituacaoChamado;
  status?: StatusChamado;
  prioridade?: Prioridade;
  responsavel: ResponsavelFila;
  natureza?: Natureza;
  complexidade?: Complexidade;
  estimativa?: FiltroEstimativaCusto;
  solicitante?: string;
  sistema?: string;
  categoria?: string;
  periodo?: PeriodoFila;
  /** Ordenação EXPLÍCITA; ausente = padrão (relevância na busca, senão atualizado desc). */
  ordem?: OrdenacaoFila;
  pagina: number;
  por: TamanhoPagina;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const BUSCA_MAX = 200;

export function ehUuid(v: string | undefined): v is string {
  return !!v && RE_UUID.test(v);
}

/** `AAAA-MM-DD` que existe no calendário (rejeita 2026-02-30). */
export function ehDataIso(v: string | undefined): v is string {
  if (!v || !RE_DATA.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function ler(sp: ParamsBrutos, chave: string): string {
  if (sp instanceof URLSearchParams) return (sp.get(chave) ?? '').trim();
  const v = sp[chave];
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

function valido<T extends string>(v: string, valores: readonly T[]): T | undefined {
  return (valores as readonly string[]).includes(v) ? (v as T) : undefined;
}

const SITUACOES: readonly SituacaoChamado[] = ['abertos', 'encerrados', 'todos'];
const ESTIMATIVAS: readonly FiltroEstimativaCusto[] = [
  ...(Object.values(EstimativaCusto) as EstimativaCusto[]),
  'sem_estimativa',
];

/**
 * Situação efetiva (D-030). Sem parâmetro explícito o padrão é `abertos` — a
 * fila é ferramenta de trabalho, não arquivo. Duas exceções evitam tela vazia
 * em links vindos de fora: um `status` específico manda (o card "Resolvidos"
 * do dashboard aponta para um status encerrado) e uma busca textual varre tudo.
 */
export function situacaoEfetiva(
  bruto: string,
  status: StatusChamado | undefined,
  busca: string,
): SituacaoChamado {
  const explicita = valido(bruto, SITUACOES);
  if (explicita) return explicita;
  if (status) return situacaoDoStatus(status);
  if (busca) return 'todos';
  return 'abertos';
}

/** Lê e VALIDA os parâmetros da URL. Valor inválido = filtro ausente (nunca erro). */
export function lerEstadoFila(sp: ParamsBrutos): EstadoFila {
  const busca = ler(sp, 'q').slice(0, BUSCA_MAX);
  const status = valido(ler(sp, 'status'), Object.values(StatusChamado));

  // Responsável: `responsavel` manda; `atribuicao` é o nome legado (dashboard).
  let responsavel: ResponsavelFila = '';
  const resp = ler(sp, 'responsavel');
  if (resp === 'meus' || resp === 'nenhum') responsavel = resp;
  else if (ehUuid(resp)) responsavel = resp.toLowerCase();
  else {
    const legado = ler(sp, 'atribuicao');
    if (legado === 'meus') responsavel = 'meus';
    else if (legado === 'nao_atribuidos') responsavel = 'nenhum';
  }

  // Alvo: sistema OU categoria (se vierem os dois, o sistema — mais específico — vence).
  const sistemaBruto = ler(sp, 'sistema');
  const categoriaBruta = ler(sp, 'categoria');
  const sistema = ehUuid(sistemaBruto) ? sistemaBruto.toLowerCase() : undefined;
  const categoria = !sistema && ehUuid(categoriaBruta) ? categoriaBruta.toLowerCase() : undefined;

  const solicitanteBruto = ler(sp, 'solicitante');

  // Período: datas válidas; invertidas são trocadas (o operador quis um intervalo).
  let periodo: PeriodoFila | undefined;
  let de = ler(sp, 'de');
  let ate = ler(sp, 'ate');
  if (!ehDataIso(de)) de = '';
  if (!ehDataIso(ate)) ate = '';
  if (de && ate && de > ate) [de, ate] = [ate, de];
  if (de || ate) {
    periodo = {
      campo: ler(sp, 'periodo') === 'atualizado' ? 'atualizado' : 'criado',
      ...(de ? { de } : {}),
      ...(ate ? { ate } : {}),
    };
  }

  const campoOrdem = valido(ler(sp, 'ordem'), CAMPOS_ORDENACAO);
  const ordem: OrdenacaoFila | undefined = campoOrdem
    ? { campo: campoOrdem, direcao: ler(sp, 'dir') === 'asc' ? 'asc' : 'desc' }
    : undefined;

  const porNum = Number(ler(sp, 'por'));
  const por = (TAMANHOS_PAGINA as readonly number[]).includes(porNum)
    ? (porNum as TamanhoPagina)
    : TAMANHO_PAGINA_PADRAO;
  const paginaNum = Number(ler(sp, 'pagina'));
  const pagina = Number.isInteger(paginaNum) && paginaNum >= 1 ? paginaNum : 1;

  return {
    busca,
    situacao: situacaoEfetiva(ler(sp, 'situacao'), status, busca),
    status,
    prioridade: valido(ler(sp, 'prioridade'), Object.values(Prioridade)),
    responsavel,
    natureza: valido(ler(sp, 'natureza'), Object.values(Natureza)),
    complexidade: valido(ler(sp, 'complexidade'), Object.values(Complexidade)),
    estimativa: valido(ler(sp, 'estimativa'), ESTIMATIVAS),
    solicitante: ehUuid(solicitanteBruto) ? solicitanteBruto.toLowerCase() : undefined,
    sistema,
    categoria,
    periodo,
    ordem,
    pagina,
    por,
  };
}

/** Estado → `FiltrosFila` da consulta (sem paginação quando `paginar` é false). */
export function paraFiltrosFila(e: EstadoFila, paginar = true): FiltrosFila {
  const f: FiltrosFila = {
    busca: e.busca || undefined,
    situacao: e.situacao,
    status: e.status,
    natureza: e.natureza,
    prioridade: e.prioridade,
    complexidade: e.complexidade,
    estimativa_custo: e.estimativa,
    cliente_id: e.solicitante,
    sistema_alvo_id: e.sistema,
    categoria_id: e.categoria,
    periodo: e.periodo,
    ordenacao: e.ordem,
  };
  if (e.responsavel === 'meus') f.atribuicao = 'meus';
  else if (e.responsavel === 'nenhum') f.atribuicao = 'nao_atribuidos';
  else if (e.responsavel) f.operador_id = e.responsavel;
  if (paginar) {
    f.pagina = e.pagina;
    f.limite = e.por;
  }
  return f;
}

/**
 * URL canônica do estado. A situação vai SEMPRE explícita (D-030: o padrão
 * depende de `q`/`status`, e a página 2 / o link compartilhado precisam herdar
 * exatamente o recorte). Padrões (página 1, 25 por página) são omitidos.
 */
export function serializarEstadoFila(
  e: EstadoFila,
  opcoes: { paginacao?: boolean } = {},
): URLSearchParams {
  const p = new URLSearchParams();
  if (e.busca) p.set('q', e.busca);
  p.set('situacao', e.situacao);
  if (e.status) p.set('status', e.status);
  if (e.prioridade) p.set('prioridade', e.prioridade);
  if (e.responsavel) p.set('responsavel', e.responsavel);
  if (e.natureza) p.set('natureza', e.natureza);
  if (e.complexidade) p.set('complexidade', e.complexidade);
  if (e.estimativa) p.set('estimativa', e.estimativa);
  if (e.solicitante) p.set('solicitante', e.solicitante);
  if (e.sistema) p.set('sistema', e.sistema);
  else if (e.categoria) p.set('categoria', e.categoria);
  if (e.periodo && (e.periodo.de || e.periodo.ate)) {
    p.set('periodo', e.periodo.campo);
    if (e.periodo.de) p.set('de', e.periodo.de);
    if (e.periodo.ate) p.set('ate', e.periodo.ate);
  }
  if (e.ordem) {
    p.set('ordem', e.ordem.campo);
    p.set('dir', e.ordem.direcao);
  }
  if (opcoes.paginacao !== false) {
    if (e.por !== TAMANHO_PAGINA_PADRAO) p.set('por', String(e.por));
    if (e.pagina > 1) p.set('pagina', String(e.pagina));
  }
  return p;
}

export const ROTA_FILA = '/app/chamados';
export const ROTA_EXPORTAR_FILA = '/app/chamados/exportar';

/**
 * Href da fila aplicando `mudancas`. Qualquer mudança que não seja de página
 * volta para a página 1 (o recorte mudou — a página N antiga não existe mais).
 */
export function hrefFila(e: EstadoFila, mudancas: Partial<EstadoFila> = {}): string {
  const soPaginacao = Object.keys(mudancas).every((k) => k === 'pagina');
  const novo: EstadoFila = { ...e, ...mudancas };
  if (!soPaginacao && mudancas.pagina === undefined) novo.pagina = 1;
  // Trocar de situação descarta um status que não pertence a ela (D-030).
  if (mudancas.situacao && novo.status && novo.situacao !== 'todos') {
    if (situacaoDoStatus(novo.status) !== novo.situacao) novo.status = undefined;
  }
  const qs = serializarEstadoFila(novo).toString();
  return qs ? `${ROTA_FILA}?${qs}` : ROTA_FILA;
}

/** Href da exportação (.xlsx) do MESMO recorte — sem paginação: exporta tudo. */
export function hrefExportacaoFila(e: EstadoFila): string {
  return `${ROTA_EXPORTAR_FILA}?${serializarEstadoFila(e, { paginacao: false }).toString()}`;
}

/**
 * Estado sem filtros. Mantém a SITUAÇÃO (é aba, não filtro), a ordem e o tamanho
 * de página. `manterBusca`: o "Limpar tudo" dos chips só limpa o que é chip; o
 * "Limpar filtros" do estado vazio limpa também a busca.
 */
export function estadoLimpo(e: EstadoFila, opcoes: { manterBusca?: boolean } = {}): EstadoFila {
  return {
    busca: opcoes.manterBusca ? e.busca : '',
    situacao: e.situacao,
    responsavel: '',
    pagina: 1,
    por: e.por,
    ordem: e.ordem,
  };
}

/** Quantos filtros do painel "Mais filtros" estão ativos (para o contador do botão). */
export function contarMaisFiltros(e: EstadoFila): number {
  return [
    e.natureza,
    e.complexidade,
    e.sistema ?? e.categoria,
    e.solicitante,
    e.estimativa,
    e.periodo,
  ].filter(Boolean).length;
}

/** Há algum filtro além da situação (para o vazio sugerir "limpar")? */
export function temFiltroAtivo(e: EstadoFila): boolean {
  return Boolean(e.busca || e.status || e.prioridade || e.responsavel || contarMaisFiltros(e));
}

/** Nomes para exibir ids nos chips (resolvidos no servidor). */
export interface NomesFila {
  operadores: Record<string, string>;
  clientes: Record<string, string>;
  sistemas: Record<string, string>;
  categorias: Record<string, string>;
}

export interface FiltroAtivo {
  chave: string;
  /** Dimensão ("Responsável"). */
  rotulo: string;
  /** Valor legível ("Marina Souza"). */
  valor: string;
  /** Mudança no estado que remove este filtro. */
  remover: Partial<EstadoFila>;
}

const fmtDiaCurto = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `AAAA-MM-DD` → `dd/mm/aaaa` (sem fuso: é uma data de calendário). */
export function dataCurta(iso: string): string {
  return fmtDiaCurto.format(new Date(`${iso}T00:00:00Z`));
}

export function rotuloEstimativaFiltro(v: FiltroEstimativaCusto): string {
  return v === 'sem_estimativa' ? 'Sem estimativa' : rotuloEstimativaCusto(v);
}

export function rotuloResponsavel(r: ResponsavelFila, nomes: NomesFila): string {
  if (r === 'meus') return 'Atribuídos a mim';
  if (r === 'nenhum') return 'Não atribuídos';
  if (!r) return 'Qualquer responsável';
  return nomes.operadores[r] ?? 'Operador removido';
}

export function rotuloPeriodo(p: PeriodoFila): string {
  const campo = p.campo === 'atualizado' ? 'Atualizado' : 'Criado';
  if (p.de && p.ate) {
    return p.de === p.ate
      ? `${campo} em ${dataCurta(p.de)}`
      : `${campo} de ${dataCurta(p.de)} a ${dataCurta(p.ate)}`;
  }
  if (p.de) return `${campo} desde ${dataCurta(p.de)}`;
  return `${campo} até ${dataCurta(p.ate!)}`;
}

/**
 * Chips de filtros ativos, na ordem da barra (uso diário → "Mais filtros").
 * A busca e a situação NÃO viram chip: têm controle próprio, sempre visível.
 */
export function filtrosAtivos(e: EstadoFila, nomes: NomesFila): FiltroAtivo[] {
  const chips: FiltroAtivo[] = [];
  if (e.responsavel) {
    chips.push({
      chave: 'responsavel',
      rotulo: 'Responsável',
      valor: rotuloResponsavel(e.responsavel, nomes),
      remover: { responsavel: '' },
    });
  }
  if (e.status) {
    chips.push({
      chave: 'status',
      rotulo: 'Status',
      valor: ROTULO_STATUS_CHAMADO[e.status],
      remover: { status: undefined },
    });
  }
  if (e.prioridade) {
    chips.push({
      chave: 'prioridade',
      rotulo: 'Prioridade',
      valor: ROTULO_PRIORIDADE[e.prioridade],
      remover: { prioridade: undefined },
    });
  }
  if (e.natureza) {
    chips.push({
      chave: 'natureza',
      rotulo: 'Natureza',
      valor: ROTULO_NATUREZA[e.natureza],
      remover: { natureza: undefined },
    });
  }
  if (e.complexidade) {
    chips.push({
      chave: 'complexidade',
      rotulo: 'Complexidade',
      valor: ROTULO_COMPLEXIDADE[e.complexidade],
      remover: { complexidade: undefined },
    });
  }
  if (e.sistema) {
    chips.push({
      chave: 'sistema',
      rotulo: 'Sistema',
      valor: nomes.sistemas[e.sistema] ?? 'Sistema removido',
      remover: { sistema: undefined },
    });
  } else if (e.categoria) {
    chips.push({
      chave: 'categoria',
      rotulo: 'Categoria',
      valor: nomes.categorias[e.categoria] ?? 'Categoria removida',
      remover: { categoria: undefined },
    });
  }
  if (e.solicitante) {
    chips.push({
      chave: 'solicitante',
      rotulo: 'Solicitante',
      valor: nomes.clientes[e.solicitante] ?? 'Cliente inativo',
      remover: { solicitante: undefined },
    });
  }
  if (e.estimativa) {
    chips.push({
      chave: 'estimativa',
      rotulo: 'Estimativa',
      valor: rotuloEstimativaFiltro(e.estimativa),
      remover: { estimativa: undefined },
    });
  }
  if (e.periodo) {
    chips.push({
      chave: 'periodo',
      rotulo: 'Período',
      valor: rotuloPeriodo(e.periodo),
      remover: { periodo: undefined },
    });
  }
  return chips;
}

/** Ordenação em vigor (explícita ou padrão). `null` = relevância da busca full-text. */
export function ordemEfetiva(e: EstadoFila, buscaPorRelevancia: boolean): OrdenacaoFila | null {
  if (e.ordem) return e.ordem;
  return buscaPorRelevancia ? null : { campo: 'atualizado', direcao: 'desc' };
}

/**
 * Estado de uma coluna ordenável e o href do clique: coluna inativa → começa
 * em `desc` (mais recente / maior / mais urgente primeiro); ativa → inverte.
 */
export function ordenacaoDaColuna(
  e: EstadoFila,
  campo: CampoOrdenacaoFila,
  buscaPorRelevancia: boolean,
): { direcao: 'asc' | 'desc' | null; href: string } {
  const atual = ordemEfetiva(e, buscaPorRelevancia);
  const ativa = atual?.campo === campo;
  const proxima: OrdenacaoFila = {
    campo,
    direcao: ativa && atual?.direcao === 'desc' ? 'asc' : 'desc',
  };
  return { direcao: ativa ? atual!.direcao : null, href: hrefFila(e, { ordem: proxima }) };
}

/** Faixa exibida no rodapé ("26–50"), sem passar do total. */
export function faixaDaPagina(
  pagina: number,
  por: number,
  itensNaPagina: number,
): { de: number; ate: number } {
  if (itensNaPagina === 0) return { de: 0, ate: 0 };
  const de = (pagina - 1) * por + 1;
  return { de, ate: de + itensNaPagina - 1 };
}
