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
    // Fundo com presença de marca (D-019 v2): véu radial derivado de --primary
    // no topo — recolore com o branding do tenant via color-mix, sem imagem.
    <main className="flex flex-1 items-center justify-center bg-[radial-gradient(ellipse_75%_55%_at_50%_-15%,color-mix(in_oklab,var(--primary),transparent_78%),transparent),linear-gradient(to_bottom,var(--background),var(--background))] px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">{children}</div>
    </main>
  );
}
