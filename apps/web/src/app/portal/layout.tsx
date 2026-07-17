import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { obterTenantAtual } from '@/lib/tenant';
import { urlLogo } from '@/lib/branding';
import { PortalHeader } from '@/components/portal/portal-header';
import { PortalSidebar } from '@/components/portal/portal-sidebar';
import { Toaster } from '@/components/ui/sonner';

/** Título da aba + favicon com a marca do tenant (whitelabel — specs/08 §7). */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await obterTenantAtual();
  const logo = urlLogo(tenant?.config_branding, 'light');
  return {
    title: tenant ? `${tenant.nome_exibicao} — Suporte` : 'Suporte',
    ...(logo ? { icons: { icon: logo } } : {}),
  };
}

/**
 * Layout do portal do cliente (specs/08 §1, §3). Guarda de papel: sem sessão →
 * /login (via `exigirUsuario`); papel ≠ cliente → /app. Branding do tenant via
 * CSS vars (injetadas no root) + logo. Sidebar escura no desktop (mesma
 * linguagem do painel — D-019 v2); no mobile o header compacto é a navegação.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { usuario, tenant } = await exigirUsuario();
  if (usuario.papel !== Papel.cliente) redirect('/app');

  const logo = urlLogo(tenant.config_branding, 'light');
  // A sidebar é superfície ESCURA: prefere a variante dark do logo (fallback light).
  const logoEscuro = urlLogo(tenant.config_branding, 'dark') ?? logo;

  return (
    <div className="flex min-h-full flex-1">
      <PortalSidebar tenantNome={tenant.nome_exibicao} logoUrl={logoEscuro} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PortalHeader tenantNome={tenant.nome_exibicao} logoUrl={logo} usuario={usuario} />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-8">{children}</main>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}
