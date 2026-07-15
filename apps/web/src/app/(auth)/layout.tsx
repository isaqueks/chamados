import type { Metadata } from 'next';
import { obterTenantAtual } from '@/lib/tenant';
import { urlLogo } from '@/lib/branding';

/** Título da aba + favicon com a marca do tenant já na tela de login (whitelabel). */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await obterTenantAtual();
  const logo = urlLogo(tenant?.config_branding, 'light');
  return {
    title: tenant ? tenant.nome_exibicao : 'Entrar',
    ...(logo ? { icons: { icon: logo } } : {}),
  };
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">{children}</div>
    </main>
  );
}
