"use server"

import { revalidatePath } from "next/cache"
import {
  obterAppDataSource,
  runInTenantContext,
  criarCategoria,
  editarCategoria,
  removerCategoria,
  type ResultadoCategoria,
} from "@chamados/db"
import { autorizar } from "@chamados/shared"
import { exigirUsuario } from "@/lib/sessao"

export interface EstadoCategoria {
  erro?: string
  sucesso?: string
}

type FalhaCategoria = Extract<ResultadoCategoria, { ok: false }>
const MOTIVOS: Record<FalhaCategoria["motivo"], string> = {
  nome_duplicado: "Já existe uma categoria com este nome.",
  nome_reservado: "“Geral” é reservado para a categoria padrão do tenant.",
  inexistente: "Categoria não encontrada.",
  protegida: "A categoria geral não pode ser alterada nem removida.",
}

function mensagem(r: FalhaCategoria): string {
  return MOTIVOS[r.motivo]
}

/** Cria uma categoria (admin). */
export async function acaoCriarCategoria(
  _prev: EstadoCategoria,
  formData: FormData,
): Promise<EstadoCategoria> {
  const { tenant, usuario } = await exigirUsuario()
  if (!autorizar(usuario, "categoria", "criar")) return { erro: "Sem permissão." }

  const nome = String(formData.get("nome") ?? "").trim()
  if (nome.length < 2) return { erro: "Informe o nome da categoria." }
  const descricao = String(formData.get("descricao") ?? "").trim() || null

  const ds = await obterAppDataSource()
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    criarCategoria(em, tenant.id, { nome, descricao }),
  )
  if (!r.ok) return { erro: mensagem(r) }

  revalidatePath("/app/categorias")
  return { sucesso: `Categoria “${nome}” criada.` }
}

/** Edita uma categoria (admin). A geral é protegida. */
export async function acaoEditarCategoria(
  _prev: EstadoCategoria,
  formData: FormData,
): Promise<EstadoCategoria> {
  const { tenant, usuario } = await exigirUsuario()
  if (!autorizar(usuario, "categoria", "editar")) return { erro: "Sem permissão." }

  const id = String(formData.get("id") ?? "")
  const nome = String(formData.get("nome") ?? "").trim()
  if (!id) return { erro: "Categoria inválida." }
  if (nome.length < 2) return { erro: "Informe o nome da categoria." }

  const ds = await obterAppDataSource()
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    editarCategoria(em, id, {
      nome,
      descricao: String(formData.get("descricao") ?? "").trim() || null,
      ativo: formData.get("ativo") === "on",
    }),
  )
  if (!r.ok) return { erro: mensagem(r) }

  revalidatePath("/app/categorias")
  return { sucesso: "Categoria atualizada." }
}

/** Remove (soft delete) uma categoria (admin). A geral é protegida. */
export async function acaoRemoverCategoria(formData: FormData): Promise<void> {
  const { tenant, usuario } = await exigirUsuario()
  if (!autorizar(usuario, "categoria", "editar")) return
  const id = String(formData.get("id") ?? "")
  if (!id) return

  const ds = await obterAppDataSource()
  await runInTenantContext(ds, tenant.id, (em) => removerCategoria(em, id))
  revalidatePath("/app/categorias")
}
