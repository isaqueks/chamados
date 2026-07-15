import { obterTenantAtual } from "@/lib/tenant"
import { urlLogo } from "@/lib/branding"

/**
 * Cabeçalho de marca do tenant resolvido (specs/07 §3, specs/08). Mostra o logo
 * (tema claro) quando cadastrado; senão, a inicial do nome de exibição. As cores
 * já vêm das CSS variables injetadas por BrandingVars.
 */
export async function CabecalhoTenant() {
  const tenant = await obterTenantAtual()
  const nome = tenant?.nome_exibicao ?? "Chamados"
  const inicial = nome.trim().charAt(0).toUpperCase() || "C"
  const logo = urlLogo(tenant?.config_branding, "light")

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={nome} className="h-11 max-w-[220px] object-contain" />
      ) : (
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground shadow-sm">
          {inicial}
        </div>
      )}
      <span className="text-base font-semibold tracking-tight">{nome}</span>
    </div>
  )
}
