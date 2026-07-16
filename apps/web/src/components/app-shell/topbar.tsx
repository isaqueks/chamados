import Link from 'next/link';
import { Bell, LogOut, ChevronDown } from 'lucide-react';
import type { UsuarioAutenticado, TenantResolvido } from '@chamados/db';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { ROTULO_PAPEL, iniciais } from '@/lib/rotulos';
import { acaoLogout } from '@/app/app/actions';
import { MobileNav } from './mobile-nav';
import { BuscaRapida } from './busca-rapida';

/**
 * Topbar do painel: navegação mobile (sheet), busca rápida por número/título,
 * indicação do tenant e menu do usuário (specs/08 §3). A identidade é escopada ao
 * tenant resolvido.
 */
export function Topbar({
  usuario,
  tenant,
  logoUrl,
}: {
  usuario: UsuarioAutenticado;
  tenant: TenantResolvido;
  logoUrl?: string | null;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <MobileNav papel={usuario.papel} tenantNome={tenant.nome_exibicao} logoUrl={logoUrl} />

      <div className="flex flex-1 justify-start">
        <BuscaRapida />
      </div>

      <div className="flex items-center gap-2">
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {tenant.nome_exibicao}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-1.5 rounded-full p-0.5 pr-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Abrir menu do usuário"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {iniciais(usuario.nome)}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex flex-col gap-0.5 px-2 py-1.5">
              <span className="truncate text-sm font-medium">{usuario.nome}</span>
              <span className="truncate text-xs text-muted-foreground">{usuario.email}</span>
              <Badge variant="secondary" className="mt-1.5 w-fit">
                {ROTULO_PAPEL[usuario.papel]}
              </Badge>
            </div>
            <DropdownMenuSeparator />
            <Link
              href="/app/preferencias"
              className="flex w-full cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
            >
              <Bell className="size-4" />
              Preferências de notificação
            </Link>
            <DropdownMenuSeparator />
            <form action={acaoLogout}>
              <button
                type="submit"
                className="flex w-full cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
              >
                <LogOut className="size-4" />
                Sair
              </button>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
