import Link from 'next/link';
import { Plus } from 'lucide-react';
import type { UsuarioAutenticado } from '@chamados/db';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { UserMenu } from './user-menu';

/**
 * Header do portal do cliente (specs/08 §3): ação primária "Abrir chamado" e
 * menu do usuário. No desktop a marca vive na sidebar (D-019 v2) — aqui ela só
 * aparece no mobile. Whitelabel puro: não exibe a marca da plataforma.
 */
export function PortalHeader({
  tenantNome,
  logoUrl,
  usuario,
}: {
  tenantNome: string;
  logoUrl: string | null;
  usuario: UsuarioAutenticado;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
        {/* Marca só no mobile — no desktop ela vive na sidebar. */}
        <Link
          href="/portal"
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden"
          aria-label={`${tenantNome} — Meus chamados`}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={tenantNome} className="h-7 max-w-[180px] object-contain" />
          ) : (
            <>
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                {tenantNome.charAt(0).toUpperCase()}
              </span>
              <span className="truncate text-sm font-semibold">{tenantNome}</span>
            </>
          )}
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <Link href="/portal/novo" className={cn(buttonVariants({ size: 'sm' }))}>
            <Plus />
            <span className="hidden sm:inline">Abrir chamado</span>
          </Link>
          <UserMenu usuario={usuario} />
        </div>
      </div>
    </header>
  );
}
