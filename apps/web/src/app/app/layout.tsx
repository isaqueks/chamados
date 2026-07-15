import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { obterTenantAtual } from '@/lib/tenant';
import { urlLogo } from '@/lib/branding';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Topbar } from '@/components/app-shell/topbar';

/** Título da aba + favicon com a marca do tenant (whitelabel — specs/08 §7). */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await obterTenantAtual();
  const logo = urlLogo(tenant?.config_branding, 'light');
  return {
    title: tenant ? `${tenant.nome_exibicao} — Painel` : 'Painel',
    ...(logo ? { icons: { icon: logo } } : {}),
  };
}

/**
 * Shell da área do painel (operador/admin). Guardas de rota (specs/03 §3, specs/08
 * §1): `exigirUsuario` exige sessão válida; o `cliente` é redirecionado ao portal
 * (o painel é exclusivo da equipe). A autorização fina por papel é aplicada nas
 * ações/páginas — a UI apenas esconde.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { usuario, tenant } = await exigirUsuario();
  if (usuario.papel === Papel.cliente) redirect('/portal');

  const logo = urlLogo(tenant.config_branding, 'light');

  return (
    <div className="flex min-h-full flex-1">
      <Sidebar papel={usuario.papel} tenantNome={tenant.nome_exibicao} logoUrl={logo} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar usuario={usuario} tenant={tenant} logoUrl={logo} />
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
