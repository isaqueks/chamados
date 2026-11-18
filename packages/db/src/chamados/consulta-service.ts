import type { EntityManager, SelectQueryBuilder } from 'typeorm';
import {
  autorizar,
  Papel,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  EstimativaCusto,
  custoDoBanco,
  valoresEnum,
  STATUS_ABERTOS,
  STATUS_ENCERRADOS,
  type SituacaoChamado,
  type Ator,
} from '@chamados/shared';
import { ChamadoSchema, type Chamado } from '../entities/chamado';
import { UsuarioSchema } from '../entities/usuario';
import { interpretarBusca, exprMatchFts, exprRankFts } from './busca';

/**
 * Consultas READ-ONLY para o painel operador/admin (fila de chamados e apoio ao
 * dashboard — specs/04 §10, specs/08 §4.4). NÃO mutam estado: apenas leem, sob
 * `runInTenantContext` (RLS escopa o tenant) e após `autorizar()`. A denormalização
 * dos nomes (solicitante/operador/sistema/categoria) é feita por LEFT JOIN em UMA
 * query, evitando N+1 na tabela densa. Complexidade só é lida pela equipe (a fila
 * é área de operador/admin — specs/03 §7). D-045: ordenação escolhida, paginação
 * por offset limitado, filtros de responsável/solicitante/período e as
 * exportações para planilha (equipe e visão pública do portal).
 */

/** Filtro de atribuição da fila (specs/08 §4.4: "Meus", "Não atribuídos", "Todos"). */
export type AtribuicaoFila = 'meus' | 'nao_atribuidos' | 'todos';

/**
 * Filtro de estimativa de custo da fila (D-043): um código da faixa ou
 * `sem_estimativa` (chamados ainda sem faixa). Aceita lista (multi-seleção —
 * OR entre os valores).
 */
export type FiltroEstimativaCusto = EstimativaCusto | 'sem_estimativa';

/** Colunas pelas quais a fila pode ser ordenada (D-045, specs/04 §10.3). */
export type CampoOrdenacaoFila = 'atualizado' | 'criado' | 'prioridade' | 'numero';
export type DirecaoOrdenacao = 'asc' | 'desc';

export interface OrdenacaoFila {
  campo: CampoOrdenacaoFila;
  direcao: DirecaoOrdenacao;
}

/**
 * Intervalo de datas (D-045): `de`/`ate` em `AAAA-MM-DD`, ambos INCLUSIVOS e
 * interpretados no fuso de exibição do produto (`FUSO_FILA`). `campo` escolhe a
 * coluna (`created_at` ou `updated_at`).
 */
export interface PeriodoFila {
  campo: 'criado' | 'atualizado';
  de?: string;
  ate?: string;
}

/** Fuso em que as datas do filtro de período são interpretadas (mesmo da UI/e-mails). */
export const FUSO_FILA = 'America/Sao_Paulo';

/** Filtros combináveis da fila (specs/04 §10.2). Todos opcionais. */
export interface FiltrosFila {
  /**
   * Busca textual (specs/04 §10.4): número de chamado → prefixo em `numero`;
   * texto → full-text `websearch_to_tsquery('portuguese')` sobre `busca_tsv`
   * (título peso A > corpo peso B) com ranking; termos curtos → ILIKE no título.
   * Ver `busca.ts`.
   */
  busca?: string;
  /**
   * Filtro rápido por situação (D-030): `abertos` (padrão da UI), `encerrados`
   * ou `todos`. Combina com `status` por interseção — quem escolhe um status
   * específico normalmente já está na situação correspondente.
   */
  situacao?: SituacaoChamado;
  status?: StatusChamado;
  natureza?: Natureza;
  prioridade?: Prioridade;
  complexidade?: Complexidade;
  /** D-043: faixa(s) de estimativa de custo; `sem_estimativa` = `IS NULL`. */
  estimativa_custo?: FiltroEstimativaCusto | FiltroEstimativaCusto[];
  atribuicao?: AtribuicaoFila;
  /**
   * D-045: responsável ESPECÍFICO (UUID de operador/admin). Mesma dimensão de
   * `atribuicao` (e tem precedência sobre ela): os contadores de responsável
   * ignoram as duas juntas. UUID malformado → nenhum resultado (fail-closed).
   */
  operador_id?: string;
  /** D-045: solicitante (UUID do cliente). Malformado → nenhum resultado. */
  cliente_id?: string;
  /** D-045: criado/atualizado entre datas (inclusivas). Data malformada → nenhum resultado. */
  periodo?: PeriodoFila;
  sistema_alvo_id?: string;
  categoria_id?: string;
  /**
   * D-045: ordenação explícita. Sem ela: relevância quando há busca full-text,
   * senão última atualização (desc). Desempate sempre por `id` — ordem TOTAL,
   * condição para a paginação por offset não repetir nem pular linhas paradas.
   */
  ordenacao?: OrdenacaoFila;
  /** Tamanho da página (1..100; default 25). */
  limite?: number;
  /**
   * Página 1-based (D-045: paginação por OFFSET limitado — `OFFSET_MAX_FILA`).
   * Substitui o cursor keyset, que não suporta ordenação arbitrária com segurança.
   */
  pagina?: number;
}

/** Linha densa da fila: campos do chamado + nomes denormalizados para exibição. */
export interface FilaChamadoItem {
  id: string;
  numero: string;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  /** D-043: faixa estimada (pública). `null` = sem estimativa. */
  estimativa_custo: EstimativaCusto | null;
  /** D-043: custo final em BRL (número). `null` = não informado. */
  custo_final: number | null;
  /** D-024: IA silenciada neste chamado (indicador interno na fila — D-045). */
  ia_silenciada: boolean;
  /** D-042: fim da janela de aprovação do cliente (só em `resolvido`). */
  fechar_automaticamente_em: Date | null;
  operador_id: string | null;
  operador_nome: string | null;
  solicitante_nome: string | null;
  sistema_nome: string | null;
  categoria_nome: string | null;
  reaberto_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface PaginaFila {
  itens: FilaChamadoItem[];
  /** Página efetivamente servida (após o teto de offset). */
  pagina: number;
  limite: number;
  /** Há pelo menos mais uma linha depois desta página (e ela é alcançável). */
  temMais: boolean;
}

/** Contadores das facetas (para os rótulos dos filtros com número — specs/08 §4.4). */
export interface ContadoresFila {
  /** Total ignorando o filtro de responsável (base de "Qualquer responsável"). */
  total: number;
  meus: number;
  naoAtribuidos: number;
  /** D-045: chamados por responsável (id → n), ignorando o filtro de responsável. */
  porOperador: Record<string, number>;
  /** D-045: total do recorte COMPLETO (todos os filtros) — o "N chamados" da tela. */
  filtrados: number;
  porStatus: Record<StatusChamado, number>;
  /**
   * Contagem dos filtros rápidos de situação (D-030), ignorando o próprio filtro
   * de situação. `total` = `abertos + encerrados`, pois os dois grupos particionam
   * exatamente os sete status canônicos.
   */
  porSituacao: { abertos: number; encerrados: number; total: number };
}

const LIMITE_PADRAO = 25;
const LIMITE_MAX = 100;
/**
 * Teto do OFFSET da fila (D-045): além disso a tela pede para refinar os
 * filtros (e a exportação cobre o recorte inteiro). Mantém o custo do OFFSET
 * previsível mesmo em tenants grandes.
 */
export const OFFSET_MAX_FILA = 10_000;
/** Teto de linhas da exportação para planilha (D-045). */
export const TETO_EXPORTACAO = 10_000;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/** `AAAA-MM-DD` que existe no calendário (rejeita 2026-02-30). */
export function dataIsoValida(v: string | undefined): v is string {
  if (!v || !RE_DATA.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A equipe (operador/admin) pode ver a fila do tenant? */
function equipePodeVerFila(ator: Ator): boolean {
  return (
    (ator.papel === Papel.operador || ator.papel === Papel.admin) &&
    autorizar(ator, 'chamado', 'ler', { tenant_id: ator.tenant_id })
  );
}

/** Condição que nunca casa — fail-closed para parâmetro malformado. */
const NENHUM = '1 = 0';

/** Coluna de data do filtro de período (mapeamento fixo — nada vem da URL para o SQL). */
const COLUNA_PERIODO: Record<PeriodoFila['campo'], string> = {
  criado: 'c.created_at',
  atualizado: 'c.updated_at',
};

/**
 * Aplica os filtros ao query builder base. `exceto` permite omitir uma dimensão
 * (usado nos contadores de facetas, que contam SEM o próprio filtro aplicado).
 * A exportação (D-045) usa esta MESMA função — a planilha é exatamente o recorte da tela.
 */
function aplicarFiltros(
  qb: SelectQueryBuilder<Chamado>,
  ator: Ator,
  filtros: FiltrosFila,
  exceto?: { status?: boolean; atribuicao?: boolean; situacao?: boolean },
): void {
  const b = interpretarBusca(filtros.busca);
  if (b.modo === 'numero') {
    qb.andWhere('CAST(c.numero AS TEXT) LIKE :bnum', { bnum: `${b.numero}%` });
  } else if (b.modo === 'ilike') {
    qb.andWhere('c.titulo ILIKE :btermo', { btermo: `%${b.termo}%` });
  } else if (b.modo === 'fts') {
    qb.andWhere(exprMatchFts('c', 'btsq'), { btsq: b.tsq });
  }
  if (filtros.natureza) qb.andWhere('c.natureza = :natureza', { natureza: filtros.natureza });
  if (filtros.prioridade)
    qb.andWhere('c.prioridade = :prioridade', { prioridade: filtros.prioridade });
  if (filtros.complexidade)
    qb.andWhere('c.complexidade = :complexidade', { complexidade: filtros.complexidade });
  if (filtros.sistema_alvo_id) {
    if (RE_UUID.test(filtros.sistema_alvo_id))
      qb.andWhere('c.sistema_alvo_id = :sa', { sa: filtros.sistema_alvo_id });
    else qb.andWhere(NENHUM);
  }
  if (filtros.categoria_id) {
    if (RE_UUID.test(filtros.categoria_id))
      qb.andWhere('c.categoria_id = :cat', { cat: filtros.categoria_id });
    else qb.andWhere(NENHUM);
  }
  if (filtros.cliente_id) {
    if (RE_UUID.test(filtros.cliente_id))
      qb.andWhere('c.cliente_id = :solicitante', { solicitante: filtros.cliente_id });
    else qb.andWhere(NENHUM);
  }
  if (filtros.periodo && (filtros.periodo.de || filtros.periodo.ate)) {
    const coluna = COLUNA_PERIODO[filtros.periodo.campo] ?? COLUNA_PERIODO.criado;
    const { de, ate } = filtros.periodo;
    if ((de && !dataIsoValida(de)) || (ate && !dataIsoValida(ate))) {
      qb.andWhere(NENHUM);
    } else {
      // `date::timestamp AT TIME ZONE fuso` = meia-noite LOCAL daquele dia como
      // instante; `ate` é inclusivo → limite exclusivo na meia-noite seguinte.
      if (de)
        qb.andWhere(`${coluna} >= (CAST(:perDe AS date)::timestamp AT TIME ZONE :perFuso)`, {
          perDe: de,
          perFuso: FUSO_FILA,
        });
      if (ate)
        qb.andWhere(`${coluna} < ((CAST(:perAte AS date) + 1)::timestamp AT TIME ZONE :perFuso)`, {
          perAte: ate,
          perFuso: FUSO_FILA,
        });
    }
  }
  if (filtros.estimativa_custo !== undefined) {
    const lista = Array.isArray(filtros.estimativa_custo)
      ? filtros.estimativa_custo
      : [filtros.estimativa_custo];
    const codigos = lista.filter((v): v is EstimativaCusto =>
      (Object.values(EstimativaCusto) as string[]).includes(v),
    );
    const semEstimativa = lista.includes('sem_estimativa');
    if (codigos.length > 0 && semEstimativa) {
      qb.andWhere('(c.estimativa_custo IN (:...estCusto) OR c.estimativa_custo IS NULL)', {
        estCusto: codigos,
      });
    } else if (codigos.length > 0) {
      qb.andWhere('c.estimativa_custo IN (:...estCusto)', { estCusto: codigos });
    } else if (semEstimativa) {
      qb.andWhere('c.estimativa_custo IS NULL');
    }
  }

  if (!exceto?.situacao && filtros.situacao && filtros.situacao !== 'todos') {
    const grupo = filtros.situacao === 'abertos' ? STATUS_ABERTOS : STATUS_ENCERRADOS;
    qb.andWhere('c.status IN (:...grupoSituacao)', { grupoSituacao: [...grupo] });
  }
  if (!exceto?.status && filtros.status) {
    qb.andWhere('c.status = :status', { status: filtros.status });
  }
  if (!exceto?.atribuicao) {
    if (filtros.operador_id) {
      if (RE_UUID.test(filtros.operador_id))
        qb.andWhere('c.operador_id = :opFiltro', { opFiltro: filtros.operador_id });
      else qb.andWhere(NENHUM);
    } else if (filtros.atribuicao === 'nao_atribuidos') {
      qb.andWhere('c.operador_id IS NULL');
    } else if (filtros.atribuicao === 'meus') {
      qb.andWhere('c.operador_id = :me', { me: ator.id });
    }
  }
}

/**
 * Ordena o query builder conforme `filtros.ordenacao` (D-045). Toda ordenação
 * termina em `c.id` — ordem total e determinística. Sem ordenação explícita, a
 * busca full-text ordena por relevância (specs/04 §10.4).
 */
function aplicarOrdenacao(qb: SelectQueryBuilder<Chamado>, filtros: FiltrosFila): void {
  const ord = filtros.ordenacao;
  if (!ord) {
    if (interpretarBusca(filtros.busca).modo === 'fts') {
      // Relevância (specs/04 §10.4) quando há busca e nenhuma ordenação escolhida.
      qb.orderBy(exprRankFts('c', 'btsq'), 'DESC')
        .addOrderBy('c.updated_at', 'DESC')
        .addOrderBy('c.id', 'DESC');
    } else {
      qb.orderBy('c.updated_at', 'DESC').addOrderBy('c.id', 'DESC');
    }
    return;
  }
  const dir = ord.direcao === 'asc' ? 'ASC' : 'DESC';
  switch (ord.campo) {
    case 'criado':
      qb.orderBy('c.created_at', dir).addOrderBy('c.id', dir);
      break;
    case 'numero':
      qb.orderBy('c.numero', dir).addOrderBy('c.id', dir);
      break;
    case 'prioridade':
      // Enum PG ordena pela declaração (baixa < media < alta < urgente). Dentro da
      // mesma prioridade, o mais recentemente atualizado primeiro (o que se espera
      // de uma fila de trabalho), qualquer que seja a direção escolhida.
      qb.orderBy('c.prioridade', dir).addOrderBy('c.updated_at', 'DESC').addOrderBy('c.id', 'DESC');
      break;
    case 'atualizado':
    default:
      qb.orderBy('c.updated_at', dir).addOrderBy('c.id', dir);
  }
}

/** Projeção base da fila (uma query, LEFT JOINs — sem N+1). */
function consultaBaseFila(em: EntityManager): SelectQueryBuilder<Chamado> {
  return em
    .createQueryBuilder(ChamadoSchema, 'c')
    .leftJoin('Usuario', 'sol', 'sol.id = c.cliente_id')
    .leftJoin('Usuario', 'op', 'op.id = c.operador_id')
    .leftJoin('SistemaAlvo', 'sa', 'sa.id = c.sistema_alvo_id')
    .leftJoin('Categoria', 'cat', 'cat.id = c.categoria_id')
    .select('c.id', 'id')
    .addSelect('c.numero', 'numero')
    .addSelect('c.titulo', 'titulo')
    .addSelect('c.status', 'status')
    .addSelect('c.natureza', 'natureza')
    .addSelect('c.prioridade', 'prioridade')
    .addSelect('c.complexidade', 'complexidade')
    .addSelect('c.estimativa_custo', 'estimativa_custo')
    .addSelect('c.custo_final', 'custo_final')
    .addSelect('c.ia_silenciada', 'ia_silenciada')
    .addSelect('c.fechar_automaticamente_em', 'fechar_automaticamente_em')
    .addSelect('c.operador_id', 'operador_id')
    .addSelect('c.reaberto_count', 'reaberto_count')
    .addSelect('c.created_at', 'created_at')
    .addSelect('c.updated_at', 'updated_at')
    .addSelect('sol.nome', 'solicitante_nome')
    .addSelect('op.nome', 'operador_nome')
    .addSelect('sa.nome', 'sistema_nome')
    .addSelect('cat.nome', 'categoria_nome')
    .where('c.deleted_at IS NULL');
}

interface LinhaBrutaFila {
  id: string;
  numero: string;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  estimativa_custo: EstimativaCusto | null;
  custo_final: string | null;
  ia_silenciada: boolean;
  fechar_automaticamente_em: Date | null;
  operador_id: string | null;
  reaberto_count: number;
  created_at: Date;
  updated_at: Date;
  solicitante_nome: string | null;
  operador_nome: string | null;
  sistema_nome: string | null;
  categoria_nome: string | null;
}

function paraItemFila(r: LinhaBrutaFila): FilaChamadoItem {
  return {
    id: r.id,
    numero: String(r.numero),
    titulo: r.titulo,
    status: r.status,
    natureza: r.natureza,
    prioridade: r.prioridade,
    complexidade: r.complexidade,
    estimativa_custo: r.estimativa_custo ?? null,
    custo_final: custoDoBanco(r.custo_final),
    ia_silenciada: Boolean(r.ia_silenciada),
    fechar_automaticamente_em: r.fechar_automaticamente_em ?? null,
    operador_id: r.operador_id,
    operador_nome: r.operador_nome,
    solicitante_nome: r.solicitante_nome,
    sistema_nome: r.sistema_nome,
    categoria_nome: r.categoria_nome,
    reaberto_count: Number(r.reaberto_count),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Normaliza `limite`/`pagina` respeitando o teto de offset (D-045). */
export function normalizarPaginacaoFila(
  pagina: number | undefined,
  limite: number | undefined,
): { pagina: number; limite: number; offset: number } {
  const lim = Math.min(
    Math.max(Math.trunc(limite ?? LIMITE_PADRAO) || LIMITE_PADRAO, 1),
    LIMITE_MAX,
  );
  const ultimaAlcancavel = Math.floor(OFFSET_MAX_FILA / lim) + 1;
  const pag = Math.min(Math.max(Math.trunc(pagina ?? 1) || 1, 1), ultimaAlcancavel);
  return { pagina: pag, limite: lim, offset: (pag - 1) * lim };
}

/**
 * Lista a fila de chamados (specs/04 §10, specs/08 §4.4) com filtros combináveis,
 * ordenação escolhida (D-045) e paginação por offset limitado. Retorna vazio
 * para quem não pode ver a fila (a UI é área de equipe).
 */
export async function listarFilaChamados(
  em: EntityManager,
  ator: Ator,
  filtros: FiltrosFila = {},
): Promise<PaginaFila> {
  const { pagina, limite, offset } = normalizarPaginacaoFila(filtros.pagina, filtros.limite);
  if (!equipePodeVerFila(ator)) return { itens: [], pagina, limite, temMais: false };

  const qb = consultaBaseFila(em);
  aplicarFiltros(qb, ator, filtros);
  aplicarOrdenacao(qb, filtros);
  // limite + 1 para saber se há próxima página sem um COUNT extra.
  qb.offset(offset).limit(limite + 1);

  const linhas = await qb.getRawMany<LinhaBrutaFila>();
  const temMais = linhas.length > limite && offset + limite <= OFFSET_MAX_FILA;
  return {
    itens: linhas.slice(0, limite).map(paraItemFila),
    pagina,
    limite,
    temMais,
  };
}

/** Linha da exportação da equipe (D-045): a fila + campos só da planilha. */
export interface LinhaExportacaoFila extends FilaChamadoItem {
  solicitante_email: string | null;
  resolvido_em: Date | null;
  fechado_em: Date | null;
}

export interface ResultadoExportacao<T> {
  itens: T[];
  /** O recorte tinha mais linhas que o teto (a planilha saiu parcial). */
  truncado: boolean;
}

/**
 * Exportação da fila para planilha (D-045): o MESMO recorte e a MESMA ordem da
 * tela (`aplicarFiltros` + `aplicarOrdenacao`), sem paginação, até `teto`
 * linhas. READ-ONLY, sob RLS; só a equipe (operador/admin) — qualquer outro
 * papel recebe vazio (fail-closed; a rota responde 403 antes).
 */
export async function exportarFilaChamados(
  em: EntityManager,
  ator: Ator,
  filtros: FiltrosFila = {},
  teto: number = TETO_EXPORTACAO,
): Promise<ResultadoExportacao<LinhaExportacaoFila>> {
  if (!equipePodeVerFila(ator)) return { itens: [], truncado: false };
  const limite = Math.min(Math.max(Math.trunc(teto) || 1, 1), TETO_EXPORTACAO);

  const qb = consultaBaseFila(em)
    .addSelect('sol.email', 'solicitante_email')
    .addSelect('c.resolvido_em', 'resolvido_em')
    .addSelect('c.fechado_em', 'fechado_em');
  aplicarFiltros(qb, ator, filtros);
  aplicarOrdenacao(qb, filtros);
  qb.limit(limite + 1);

  const linhas = await qb.getRawMany<
    LinhaBrutaFila & {
      solicitante_email: string | null;
      resolvido_em: Date | null;
      fechado_em: Date | null;
    }
  >();
  return {
    itens: linhas.slice(0, limite).map((r) => ({
      ...paraItemFila(r),
      solicitante_email: r.solicitante_email,
      resolvido_em: r.resolvido_em ?? null,
      fechado_em: r.fechado_em ?? null,
    })),
    truncado: linhas.length > limite,
  };
}

/**
 * Contadores das facetas da fila. `porStatus` conta ignorando os filtros de status
 * E de situação (para cada opção mostrar quantos há dentro dos demais filtros);
 * `porSituacao` deriva dele; `porOperador`/`meus`/`naoAtribuidos`/`total` ignoram
 * o filtro de responsável (e portanto refletem a situação selecionada);
 * `filtrados` é o recorte completo. Duas queries no total.
 */
export async function contarFila(
  em: EntityManager,
  ator: Ator,
  filtros: FiltrosFila = {},
): Promise<ContadoresFila> {
  const zero = Object.fromEntries(valoresEnum(StatusChamado).map((s) => [s, 0])) as Record<
    StatusChamado,
    number
  >;
  if (!equipePodeVerFila(ator)) {
    return {
      total: 0,
      meus: 0,
      naoAtribuidos: 0,
      porOperador: {},
      filtrados: 0,
      porStatus: zero,
      porSituacao: { abertos: 0, encerrados: 0, total: 0 },
    };
  }

  // Contagem por status (ignora o próprio filtro de status).
  const qbStatus = em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('c.status', 'status')
    .addSelect('COUNT(*)', 'n')
    .where('c.deleted_at IS NULL')
    .groupBy('c.status');
  aplicarFiltros(qbStatus, ator, filtros, { status: true, situacao: true });
  const linhasStatus = await qbStatus.getRawMany<{ status: StatusChamado; n: string }>();
  const porStatus = { ...zero };
  for (const l of linhasStatus) porStatus[l.status] = Number(l.n);

  // Filtros rápidos de situação (ignora o próprio filtro de situação). Os dois
  // grupos particionam os sete status, então o total sai da soma.
  const abertos = STATUS_ABERTOS.reduce((soma, s) => soma + porStatus[s], 0);
  const encerrados = STATUS_ENCERRADOS.reduce((soma, s) => soma + porStatus[s], 0);

  // Por responsável (ignora o próprio filtro de responsável): uma linha por
  // operador + a linha NULL (não atribuídos). Total, "meus" e "não atribuídos"
  // saem da mesma agregação.
  const qbResp = em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('c.operador_id', 'operador_id')
    .addSelect('COUNT(*)', 'n')
    .where('c.deleted_at IS NULL')
    .groupBy('c.operador_id');
  aplicarFiltros(qbResp, ator, filtros, { atribuicao: true });
  const linhasResp = await qbResp.getRawMany<{ operador_id: string | null; n: string }>();
  const porOperador: Record<string, number> = {};
  let total = 0;
  let naoAtribuidos = 0;
  for (const l of linhasResp) {
    const n = Number(l.n);
    total += n;
    if (l.operador_id === null) naoAtribuidos = n;
    else porOperador[l.operador_id] = n;
  }
  const meus = porOperador[ator.id] ?? 0;

  let filtrados = total;
  if (filtros.operador_id) filtrados = porOperador[filtros.operador_id] ?? 0;
  else if (filtros.atribuicao === 'meus') filtrados = meus;
  else if (filtros.atribuicao === 'nao_atribuidos') filtrados = naoAtribuidos;

  return {
    total,
    meus,
    naoAtribuidos,
    porOperador,
    filtrados,
    porStatus,
    porSituacao: { abertos, encerrados, total: abertos + encerrados },
  };
}

/** Linha da exportação do PORTAL (D-045): só campos da visão pública (specs/03 §7). */
export interface LinhaExportacaoPublica {
  numero: string;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  estimativa_custo: EstimativaCusto | null;
  custo_final: number | null;
  /** É o próprio ator? (a planilha diz "Você" em vez do nome). */
  solicitante_eh_voce: boolean;
  solicitante_nome: string | null;
  sistema_nome: string | null;
  categoria_nome: string | null;
  reaberto_count: number;
  created_at: Date;
  updated_at: Date;
  resolvido_em: Date | null;
  fechado_em: Date | null;
}

export interface FiltrosExportacaoPublica {
  /** Recorte "Meus chamados" (D-037). */
  meus?: boolean;
  status?: StatusChamado[];
  busca?: string;
}

/**
 * Exportação da lista do PORTAL (D-045). Projeção ALLOWLIST montada aqui mesmo
 * (nunca seleciona `complexidade`, `operador_id`, `ia_silenciada`, e-mails nem
 * nada interno): é a mesma visão pública de `serializarChamadoParaCliente`, com
 * os nomes que o portal já mostra (solicitante no recorte "Todos" — D-037 —,
 * sistema/categoria). Mesmo recorte do portal: `meus`, grupo de status e busca;
 * ordem por última atualização. Exige `chamado · ler` no tenant; RLS escopa.
 */
export async function exportarChamadosVisaoPublica(
  em: EntityManager,
  ator: Ator,
  filtros: FiltrosExportacaoPublica = {},
  teto: number = TETO_EXPORTACAO,
): Promise<ResultadoExportacao<LinhaExportacaoPublica>> {
  if (!autorizar(ator, 'chamado', 'ler', { tenant_id: ator.tenant_id, cliente_id: ator.id })) {
    return { itens: [], truncado: false };
  }
  const limite = Math.min(Math.max(Math.trunc(teto) || 1, 1), TETO_EXPORTACAO);

  const qb = em
    .createQueryBuilder(ChamadoSchema, 'c')
    .leftJoin('Usuario', 'sol', 'sol.id = c.cliente_id')
    .leftJoin('SistemaAlvo', 'sa', 'sa.id = c.sistema_alvo_id')
    .leftJoin('Categoria', 'cat', 'cat.id = c.categoria_id')
    .select('c.numero', 'numero')
    .addSelect('c.titulo', 'titulo')
    .addSelect('c.status', 'status')
    .addSelect('c.natureza', 'natureza')
    .addSelect('c.prioridade', 'prioridade')
    .addSelect('c.estimativa_custo', 'estimativa_custo')
    .addSelect('c.custo_final', 'custo_final')
    .addSelect('c.cliente_id', 'cliente_id')
    .addSelect('sol.nome', 'solicitante_nome')
    .addSelect('sa.nome', 'sistema_nome')
    .addSelect('cat.nome', 'categoria_nome')
    .addSelect('c.reaberto_count', 'reaberto_count')
    .addSelect('c.created_at', 'created_at')
    .addSelect('c.updated_at', 'updated_at')
    .addSelect('c.resolvido_em', 'resolvido_em')
    .addSelect('c.fechado_em', 'fechado_em')
    .where('c.deleted_at IS NULL');

  if (filtros.meus) qb.andWhere('c.cliente_id = :autor', { autor: ator.id });
  if (filtros.status && filtros.status.length > 0) {
    qb.andWhere('c.status IN (:...status)', { status: filtros.status });
  }
  const b = interpretarBusca(filtros.busca);
  if (b.modo === 'numero') {
    qb.andWhere('CAST(c.numero AS TEXT) LIKE :bnum', { bnum: `${b.numero}%` });
  } else if (b.modo === 'ilike') {
    qb.andWhere('c.titulo ILIKE :btermo', { btermo: `%${b.termo}%` });
  } else if (b.modo === 'fts') {
    qb.andWhere(exprMatchFts('c', 'btsq'), { btsq: b.tsq });
  }
  qb.orderBy('c.updated_at', 'DESC')
    .addOrderBy('c.id', 'DESC')
    .limit(limite + 1);

  const linhas = await qb.getRawMany<{
    numero: string;
    titulo: string;
    status: StatusChamado;
    natureza: Natureza;
    prioridade: Prioridade;
    estimativa_custo: EstimativaCusto | null;
    custo_final: string | null;
    cliente_id: string;
    solicitante_nome: string | null;
    sistema_nome: string | null;
    categoria_nome: string | null;
    reaberto_count: number;
    created_at: Date;
    updated_at: Date;
    resolvido_em: Date | null;
    fechado_em: Date | null;
  }>();
  return {
    itens: linhas.slice(0, limite).map((r) => ({
      numero: String(r.numero),
      titulo: r.titulo,
      status: r.status,
      natureza: r.natureza,
      prioridade: r.prioridade,
      estimativa_custo: r.estimativa_custo ?? null,
      custo_final: custoDoBanco(r.custo_final),
      solicitante_eh_voce: r.cliente_id === ator.id,
      solicitante_nome: r.solicitante_nome,
      sistema_nome: r.sistema_nome,
      categoria_nome: r.categoria_nome,
      reaberto_count: Number(r.reaberto_count),
      created_at: r.created_at,
      updated_at: r.updated_at,
      resolvido_em: r.resolvido_em ?? null,
      fechado_em: r.fechado_em ?? null,
    })),
    truncado: linhas.length > limite,
  };
}

/** Operador de exibição/atribuição (equipe do tenant, ativos). */
export interface OperadorResumo {
  id: string;
  nome: string;
  papel: Papel;
}

/**
 * Lista os operadores/admins ativos do tenant (para o seletor de atribuição —
 * specs/04 §7). READ-ONLY. RLS escopa o tenant; filtra por papel de equipe.
 */
export async function listarOperadoresDoTenant(em: EntityManager): Promise<OperadorResumo[]> {
  const linhas = await em
    .createQueryBuilder(UsuarioSchema, 'u')
    .select(['u.id AS id', 'u.nome AS nome', 'u.papel AS papel'])
    .where('u.deleted_at IS NULL')
    .andWhere('u.status = :ativo', { ativo: 'ativo' })
    .andWhere('u.papel IN (:...papeis)', { papeis: [Papel.operador, Papel.admin] })
    .orderBy('u.nome', 'ASC')
    .getRawMany<OperadorResumo>();
  return linhas.map((l) => ({ id: l.id, nome: l.nome, papel: l.papel }));
}

/** Cliente selecionável como solicitante (D-040): só o necessário para escolher. */
export interface ClienteResumo {
  id: string;
  nome: string;
  email: string;
}

/**
 * Lista os clientes ATIVOS do tenant para o seletor de solicitante do "Novo
 * chamado" do painel (D-040, specs/04 §2). READ-ONLY. Só a equipe que pode abrir
 * chamado em nome de cliente (operador/admin) recebe a lista — qualquer outro
 * papel recebe `[]` (fail-closed; não é `usuario · listar`, que segue admin-only).
 * O universo é exatamente o que `criarChamado` aceita como solicitante (papel
 * `cliente`, `status = ativo`, não removido). RLS escopa o tenant.
 */
export async function listarClientesAtivosDoTenant(
  em: EntityManager,
  ator: Ator,
): Promise<ClienteResumo[]> {
  if (ator.papel !== Papel.operador && ator.papel !== Papel.admin) return [];
  if (!autorizar(ator, 'chamado', 'criar')) return [];
  const linhas = await em
    .createQueryBuilder(UsuarioSchema, 'u')
    .select(['u.id AS id', 'u.nome AS nome', 'u.email AS email'])
    .where('u.deleted_at IS NULL')
    .andWhere('u.status = :ativo', { ativo: 'ativo' })
    .andWhere('u.papel = :cliente', { cliente: Papel.cliente })
    .orderBy('u.nome', 'ASC')
    .addOrderBy('u.email', 'ASC')
    .getRawMany<ClienteResumo>();
  return linhas.map((l) => ({ id: l.id, nome: l.nome, email: l.email }));
}
