import { exigirUsuario } from "@/lib/sessao"
import { urlLogo } from "@/lib/branding"
import { Sidebar } from "@/components/app-shell/sidebar"
import { Topbar } from "@/components/app-shell/topbar"

/**
 * Shell da área autenticada. Guarda de rota: `exigirUsuario` redireciona ao
 * /login se não houver sessão válida (specs/03 §3). A autorização por papel é
 * aplicada nas ações/páginas (a UI apenas esconde).
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { usuario, tenant } = await exigirUsuario()
  const logo = urlLogo(tenant.config_branding, "light")

  return (
    <div className="flex min-h-full flex-1">
      <Sidebar
        papel={usuario.papel}
        tenantNome={tenant.nome_exibicao}
        logoUrl={logo}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar usuario={usuario} />
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
