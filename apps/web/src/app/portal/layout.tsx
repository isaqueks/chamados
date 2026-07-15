import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { obterTenantAtual } from '@/lib/tenant';
import { urlLogo } from '@/lib/branding';
import { PortalHeader } from '@/components/portal/portal-header';
import { Toaster } from '@/components/ui/sonner';

/** Título da aba com o nome do tenant (whitelabel — specs/08 §7). */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await obterTenantAtual();
  return { title: tenant ? `${tenant.nome_exibicao} — Suporte` : 'Suporte' };
}

/**
 * Layout do portal do cliente (specs/08 §1, §3). Guarda de papel: sem sessão →
 * /login (via `exigirUsuario`); papel ≠ cliente → /app. Branding do tenant via
 * CSS vars (injetadas no root) + logo. Coluna única, minimalista, sem sidebar.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { usuario, tenant } = await exigirUsuario();
  if (usuario.papel !== Papel.cliente) redirect('/app');

  const logo = urlLogo(tenant.config_branding, 'light');

  return (
    <div className="flex min-h-full flex-1 flex-col bg-muted/20">
      <PortalHeader tenantNome={tenant.nome_exibicao} logoUrl={logo} usuario={usuario} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-8">{children}</main>
      <Toaster position="top-center" />
    </div>
  );
}
