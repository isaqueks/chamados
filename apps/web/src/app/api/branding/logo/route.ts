import { obterObjeto } from "@chamados/storage"
import { obterTenantAtual } from "@/lib/tenant"
import { chaveLogo, type VarianteLogo } from "@/lib/branding"

// Precisa do runtime Node (aws-sdk/pg) e nunca é pré-renderizado.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Serve o logo do tenant resolvido (specs/07 §3.1/§6.2). O asset é "público"
 * para visitantes do tenant, mas nunca por ACL pública de bucket: é servido por
 * PATH controlado pela aplicação, com o objeto lido do storage privado e escopado
 * ao `tenant_id` (prefixo por tenant). `X-Content-Type-Options: nosniff` impede
 * execução/renderização perigosa.
 */
export async function GET(request: Request) {
  const tenant = await obterTenantAtual()
  if (!tenant) return new Response("Tenant não resolvido", { status: 404 })

  const url = new URL(request.url)
  const variante = (url.searchParams.get("variant") ?? "light") as VarianteLogo
  if (variante !== "light" && variante !== "dark") {
    return new Response("Variante inválida", { status: 400 })
  }

  const chave = chaveLogo(tenant.config_branding, variante)
  if (!chave) return new Response("Sem logo", { status: 404 })

  // Segurança: a chave DEVE estar sob o prefixo do tenant resolvido (defesa
  // contra qualquer chave adulterada que tenha entrado na config).
  if (!chave.startsWith(`tenants/${tenant.id}/`)) {
    return new Response("Chave inválida", { status: 403 })
  }

  const objeto = await obterObjeto(chave)
  if (!objeto) return new Response("Logo não encontrado", { status: 404 })

  return new Response(new Uint8Array(objeto.corpo), {
    status: 200,
    headers: {
      "Content-Type": objeto.contentType,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
