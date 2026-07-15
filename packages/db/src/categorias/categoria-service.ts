import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { CategoriaSchema, type Categoria } from '../entities/categoria';

/**
 * CRUD de Categoria (specs/02, specs/07 §5). A categoria "Geral" é criada no
 * provisionamento e é PROTEGIDA: não pode ser renomeada, desativada nem
 * removida (é o fallback de chamados sem sistema-alvo específico).
 */

/** Nome canônico da categoria geral (fallback do tenant). */
export const NOME_CATEGORIA_GERAL = 'Geral';

/** Uma categoria é a geral (protegida)? */
export function ehCategoriaGeral(c: Pick<Categoria, 'nome'>): boolean {
  return c.nome === NOME_CATEGORIA_GERAL;
}

/**
 * Garante a categoria geral do tenant (idempotente). Chamada no provisionamento
 * e no seed. Retorna o id da categoria geral.
 */
export async function garantirCategoriaGeral(em: EntityManager, tenantId: string): Promise<string> {
  const existente = await em.findOne(CategoriaSchema, {
    where: { nome: NOME_CATEGORIA_GERAL },
  });
  if (existente) return existente.id;
  const res = await em.insert(CategoriaSchema, {
    tenant_id: tenantId,
    nome: NOME_CATEGORIA_GERAL,
    descricao: 'Chamados sem um sistema-alvo específico.',
    ativo: true,
  });
  return res.identifiers[0]!.id as string;
}

/** Lista as categorias do tenant (a geral primeiro). */
export async function listarCategorias(
  em: EntityManager,
  opts: { incluirInativas?: boolean } = {},
): Promise<Categoria[]> {
  const where = opts.incluirInativas
    ? { deleted_at: IsNull() }
    : { deleted_at: IsNull(), ativo: true };
  const linhas = await em.find(CategoriaSchema, {
    where,
    order: { nome: 'ASC' },
  });
  // Geral primeiro, resto alfabético.
  return linhas.sort((a, b) => {
    if (ehCategoriaGeral(a)) return -1;
    if (ehCategoriaGeral(b)) return 1;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });
}

/** Busca uma categoria por id. `null` se não existir. */
export async function buscarCategoria(em: EntityManager, id: string): Promise<Categoria | null> {
  return em.findOne(CategoriaSchema, { where: { id, deleted_at: IsNull() } });
}

export type ResultadoCategoria =
  | { ok: true; id: string }
  | { ok: false; motivo: 'nome_duplicado' | 'nome_reservado' | 'inexistente' | 'protegida' };

/** Cria uma categoria. Recusa o nome reservado "Geral" e duplicatas. */
export async function criarCategoria(
  em: EntityManager,
  tenantId: string,
  dados: { nome: string; descricao?: string | null },
): Promise<ResultadoCategoria> {
  const nome = dados.nome.trim();
  if (nome === NOME_CATEGORIA_GERAL) return { ok: false, motivo: 'nome_reservado' };

  const jaExiste = await em.findOne(CategoriaSchema, { where: { nome } });
  if (jaExiste) return { ok: false, motivo: 'nome_duplicado' };

  const res = await em.insert(CategoriaSchema, {
    tenant_id: tenantId,
    nome,
    descricao: dados.descricao?.trim() || null,
    ativo: true,
  });
  return { ok: true, id: res.identifiers[0]!.id as string };
}

/** Edita nome/descrição/ativo de uma categoria (a geral não é editável). */
export async function editarCategoria(
  em: EntityManager,
  id: string,
  dados: { nome?: string; descricao?: string | null; ativo?: boolean },
): Promise<ResultadoCategoria> {
  const atual = await buscarCategoria(em, id);
  if (!atual) return { ok: false, motivo: 'inexistente' };
  if (ehCategoriaGeral(atual)) return { ok: false, motivo: 'protegida' };

  const nome = dados.nome?.trim() ?? atual.nome;
  if (nome === NOME_CATEGORIA_GERAL) return { ok: false, motivo: 'nome_reservado' };
  if (nome !== atual.nome) {
    const jaExiste = await em.findOne(CategoriaSchema, { where: { nome } });
    if (jaExiste) return { ok: false, motivo: 'nome_duplicado' };
  }

  await em.update(
    CategoriaSchema,
    { id },
    {
      nome,
      descricao: dados.descricao === undefined ? atual.descricao : dados.descricao?.trim() || null,
      ativo: dados.ativo ?? atual.ativo,
    },
  );
  return { ok: true, id };
}

/** Remove (soft delete) uma categoria. A geral é protegida. */
export async function removerCategoria(em: EntityManager, id: string): Promise<ResultadoCategoria> {
  const atual = await buscarCategoria(em, id);
  if (!atual) return { ok: false, motivo: 'inexistente' };
  if (ehCategoriaGeral(atual)) return { ok: false, motivo: 'protegida' };
  await em.softDelete(CategoriaSchema, { id });
  return { ok: true, id };
}
