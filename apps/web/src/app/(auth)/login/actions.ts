"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { obterAppDataSource, autenticarComSenha } from "@chamados/db"
import { obterTenantAtual } from "@/lib/tenant"
import { definirCookieSessao } from "@/lib/cookies"

export interface EstadoLogin {
  erro?: string
}

/**
 * Autentica no tenant resolvido (specs/03 §4.1). Falha sempre com mensagem
 * genérica (anti-enumeração). Em sucesso, grava o cookie de sessão e redireciona.
 */
export async function acaoLogin(
  _prev: EstadoLogin,
  formData: FormData
): Promise<EstadoLogin> {
  const email = String(formData.get("email") ?? "").trim()
  const senha = String(formData.get("senha") ?? "")
  if (!email || !senha) return { erro: "Informe e-mail e senha." }

  const tenant = await obterTenantAtual()
  if (!tenant) return { erro: "Endereço de tenant desconhecido." }

  const h = await headers()
  const ds = await obterAppDataSource()
  const r = await autenticarComSenha(ds, tenant, {
    email,
    senha,
    userAgent: h.get("user-agent") ?? undefined,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
  })

  if (!r.ok) return { erro: "E-mail ou senha inválidos." }

  await definirCookieSessao(r.token)
  redirect("/app")
}
