import { obterTenantAtual } from "@/lib/tenant"
import { cssBranding } from "@/lib/branding"

/**
 * Injeta as CSS variables de branding do tenant resolvido (specs/07 §3.2). Um
 * `<style>` com `:root { --primary: … }` sobrescreve os defaults neutros do
 * design system. Sem tenant ou sem cores válidas/aprovadas no contraste,
 * renderiza nada (fallback neutro). Aplica-se ao login e ao app.
 */
export async function BrandingVars() {
  const tenant = await obterTenantAtual()
  const css = cssBranding(tenant?.config_branding)
  if (!css) return null
  return <style id="tenant-branding" dangerouslySetInnerHTML={{ __html: css }} />
}
