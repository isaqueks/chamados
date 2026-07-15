import { obterTenantAtual } from "@/lib/tenant"

/**
 * Cabeçalho de marca do tenant resolvido (nome de exibição). Branding completo
 * (logo/cores) é E-03 (M2); aqui exibimos ao menos o nome, conforme specs/08.
 */
export async function CabecalhoTenant() {
  const tenant = await obterTenantAtual()
  const nome = tenant?.nome_exibicao ?? "Chamados"
  const inicial = nome.trim().charAt(0).toUpperCase() || "C"

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground shadow-sm">
        {inicial}
      </div>
      <span className="text-base font-semibold tracking-tight">{nome}</span>
    </div>
  )
}
