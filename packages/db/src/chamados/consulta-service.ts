import type { EntityManager, SelectQueryBuilder } from 'typeorm';
import {
  autorizar,
  Papel,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  valoresEnum,
  type Ator,
} from '@chamados/shared';
import { ChamadoSchema, type Chamado } from '../entities/chamado';
import { UsuarioSchema } from '../entities/usuario';

/**
 * Consultas READ-ONLY para o painel operador/admin (fila de chamados e apoio ao
 * dashboard — specs/04 §10, specs/08 §4.4). NÃO mutam estado: apenas leem, sob
 * `runInTenantContext` (RLS escopa o tenant) e após `autorizar()`. A denormalização
 * dos nomes (solicitante/operador/sistema/categoria) é feita por LEFT JOIN em UMA
 * query, evitando N+1 na tabela densa. Complexidade só é lida pela equipe (a fila
 * é área de operador/admin — specs/03 §7).
 */

/** Filtro de atribuição da fila (specs/08 §4.4: "Meus", "Não atribuídos", "Todos"). */
export type AtribuicaoFila = 'meus' | 'nao_atribuidos' | 'todos';

/** Filtros combináveis da fila (specs/04 §10.2). Todos opcionais. */
export interface FiltrosFila {
  /** Busca ILIKE por número OU título (full-text fica para M10 — specs/04 §10.4). */
  busca?: string;
  status?: StatusChamado;
  natureza?: Natureza;
  prioridade?: Prioridade;
  complexidade?: Complexidade;
  atribuicao?: AtribuicaoFila;
  sistema_alvo_id?: string;
  categoria_id?: string;
  limite?: number;
  cursor?: string;
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
  proximoCursor: string | null;
}

/** Contadores das facetas (para os chips de filtro com número — specs/08 §4.4). */
export interface ContadoresFila {
  total: number;
  meus: number;
  naoAtribuidos: number;
  porStatus: Record<StatusChamado, number>;
}

const LIMITE_PADRAO = 25;
const LIMITE_MAX = 100;

function encodeCursor(updated_at: Date | string, id: string): string {
  const iso = new Date(updated_at).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updated_at: string; id: string } | null {
  try {
    const [updated_at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!updated_at || !id) return null;
    return { updated_at, id };
  } catch {
    return null;
  }
}

/** A equipe (operador/admin) pode ver a fila do tenant? */
function equipePodeVerFila(ator: Ator): boolean {
  return (
    (ator.papel === Papel.operador || ator.papel === Papel.admin) &&
    autorizar(ator, 'chamado', 'ler', { tenant_id: ator.tenant_id })
  );
}

/**
 * Aplica os filtros ao query builder base. `exceto` permite omitir uma dimensão
 * (usado nos contadores de facetas, que contam SEM o próprio filtro aplicado).
 */
function aplicarFiltros(
  qb: SelectQueryBuilder<Chamado>,
  ator: Ator,
  filtros: FiltrosFila,
  exceto?: { status?: boolean; atribuicao?: boolean },
): void {
  if (filtros.busca && filtros.busca.trim() !== '') {
    const termo = `%${filtros.busca.trim()}%`;
    qb.andWhere('(c.titulo ILIKE :termo OR CAST(c.numero AS TEXT) ILIKE :termo)', { termo });
  }
  if (filtros.natureza) qb.andWhere('c.natureza = :natureza', { natureza: filtros.natureza });
  if (filtros.prioridade)
    qb.andWhere('c.prioridade = :prioridade', { prioridade: filtros.prioridade });
  if (filtros.complexidade)
    qb.andWhere('c.complexidade = :complexidade', { complexidade: filtros.complexidade });
  if (filtros.sistema_alvo_id)
    qb.andWhere('c.sistema_alvo_id = :sa', { sa: filtros.sistema_alvo_id });
  if (filtros.categoria_id) qb.andWhere('c.categoria_id = :cat', { cat: filtros.categoria_id });

  if (!exceto?.status && filtros.status) {
    qb.andWhere('c.status = :status', { status: filtros.status });
  }
  if (!exceto?.atribuicao && filtros.atribuicao && filtros.atribuicao !== 'todos') {
    if (filtros.atribuicao === 'nao_atribuidos') {
      qb.andWhere('c.operador_id IS NULL');
    } else if (filtros.atribuicao === 'meus') {
      qb.andWhere('c.operador_id = :me', { me: ator.id });
    }
  }
}

/**
 * Lista a fila de chamados (specs/04 §10, specs/08 §4.4) com filtros combináveis,
 * ordenação por última atualização (desc) e keyset pagination por `(updated_at,
 * id)`. Retorna vazio para quem não pode ver a fila (a UI é área de equipe).
 */
export async function listarFilaChamados(
  em: EntityManager,
  ator: Ator,
  filtros: FiltrosFila = {},
): Promise<PaginaFila> {
  if (!equipePodeVerFila(ator)) return { itens: [], proximoCursor: null };

  const limite = Math.min(Math.max(filtros.limite ?? LIMITE_PADRAO, 1), LIMITE_MAX);

  const qb = em
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
    .addSelect('c.operador_id', 'operador_id')
    .addSelect('c.reaberto_count', 'reaberto_count')
    .addSelect('c.created_at', 'created_at')
    .addSelect('c.updated_at', 'updated_at')
    .addSelect('sol.nome', 'solicitante_nome')
    .addSelect('op.nome', 'operador_nome')
    .addSelect('sa.nome', 'sistema_nome')
    .addSelect('cat.nome', 'categoria_nome')
    .where('c.deleted_at IS NULL');

  aplicarFiltros(qb, ator, filtros);

  if (filtros.cursor) {
    const cur = decodeCursor(filtros.cursor);
    if (cur) {
      qb.andWhere('(c.updated_at, c.id) < (:cu::timestamptz, :ci::uuid)', {
        cu: cur.updated_at,
        ci: cur.id,
      });
    }
  }

  qb.orderBy('c.updated_at', 'DESC')
    .addOrderBy('c.id', 'DESC')
    .limit(limite + 1);

  const linhas = await qb.getRawMany<{
    id: string;
    numero: string;
    titulo: string;
    status: StatusChamado;
    natureza: Natureza;
    prioridade: Prioridade;
    complexidade: Complexidade | null;
    operador_id: string | null;
    reaberto_count: number;
    created_at: Date;
    updated_at: Date;
    solicitante_nome: string | null;
    operador_nome: string | null;
    sistema_nome: string | null;
    categoria_nome: string | null;
  }>();

  const temMais = linhas.length > limite;
  const pagina = temMais ? linhas.slice(0, limite) : linhas;
  const ultimo = pagina[pagina.length - 1];
  const proximoCursor = temMais && ultimo ? encodeCursor(ultimo.updated_at, ultimo.id) : null;

  return {
    itens: pagina.map((r) => ({
      id: r.id,
      numero: String(r.numero),
      titulo: r.titulo,
      status: r.status,
      natureza: r.natureza,
      prioridade: r.prioridade,
      complexidade: r.complexidade,
      operador_id: r.operador_id,
      operador_nome: r.operador_nome,
      solicitante_nome: r.solicitante_nome,
      sistema_nome: r.sistema_nome,
      categoria_nome: r.categoria_nome,
      reaberto_count: Number(r.reaberto_count),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    proximoCursor,
  };
}

/**
 * Contadores das facetas da fila. `porStatus` conta ignorando o filtro de status
 * (para o chip mostrar quantos há de cada status dentro dos demais filtros);
 * `meus`/`naoAtribuidos`/`total` ignoram o filtro de atribuição.
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
    return { total: 0, meus: 0, naoAtribuidos: 0, porStatus: zero };
  }

  // Contagem por status (ignora o próprio filtro de status).
  const qbStatus = em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('c.status', 'status')
    .addSelect('COUNT(*)', 'n')
    .where('c.deleted_at IS NULL')
    .groupBy('c.status');
  aplicarFiltros(qbStatus, ator, filtros, { status: true });
  const linhasStatus = await qbStatus.getRawMany<{ status: StatusChamado; n: string }>();
  const porStatus = { ...zero };
  for (const l of linhasStatus) porStatus[l.status] = Number(l.n);

  // Totais e atribuição (ignora o próprio filtro de atribuição).
  const qbAtrib = em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('COUNT(*)', 'total')
    .addSelect('COUNT(*) FILTER (WHERE c.operador_id = :me)', 'meus')
    .addSelect('COUNT(*) FILTER (WHERE c.operador_id IS NULL)', 'nao')
    .where('c.deleted_at IS NULL')
    .setParameter('me', ator.id);
  aplicarFiltros(qbAtrib, ator, filtros, { atribuicao: true });
  const totais = await qbAtrib.getRawOne<{ total: string; meus: string; nao: string }>();

  return {
    total: Number(totais?.total ?? 0),
    meus: Number(totais?.meus ?? 0),
    naoAtribuidos: Number(totais?.nao ?? 0),
    porStatus,
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
