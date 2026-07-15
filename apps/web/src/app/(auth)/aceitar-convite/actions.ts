"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { obterAppDataSource, aceitarConviteFluxo, abrirSessao } from "@chamados/db"
import { obterTenantAtual } from "@/lib/tenant"
import { definirCookieSessao } from "@/lib/cookies"

export interface EstadoAceite {
  erro?: string
}

/**
 * Aceita o convite: define a senha, cria a conta ativa no tenant (specs/03 §4.2)
 * e já abre a sessão (auto-login), redirecionando ao painel.
 */
export async function acaoAceitarConvite(
  _prev: EstadoAceite,
  formData: FormData
): Promise<EstadoAceite> {
  const token = String(formData.get("token") ?? "")
  const nome = String(formData.get("nome") ?? "").trim()
  const senha = String(formData.get("senha") ?? "")
  const confirma = String(formData.get("confirma") ?? "")

  if (!token) return { erro: "Convite inválido." }
  if (!nome) return { erro: "Informe seu nome." }
  if (senha.length < 8) return { erro: "A senha deve ter ao menos 8 caracteres." }
  if (senha !== confirma) return { erro: "As senhas não conferem." }

  const tenant = await obterTenantAtual()
  if (!tenant) return { erro: "Endereço de tenant desconhecido." }

  const ds = await obterAppDataSource()
  const r = await aceitarConviteFluxo(ds, tenant.id, token, { nome, senha })
  if (!r.ok) {
    const msg =
      r.motivo === "expirado"
        ? "Este convite expirou. Peça um novo ao administrador."
        : r.motivo === "conta_existente"
          ? "Já existe uma conta para este e-mail neste tenant."
          : "Convite inválido ou já utilizado."
    return { erro: msg }
  }

  const h = await headers()
  const token_sessao = await abrirSessao(ds, tenant.id, r.usuario_id, {
    user_agent: h.get("user-agent") ?? undefined,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
  })
  await definirCookieSessao(token_sessao)
  redirect("/app")
}
