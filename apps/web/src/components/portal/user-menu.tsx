'use client';

import Link from 'next/link';
import { Bell, ChevronDown, LogOut } from 'lucide-react';
import type { UsuarioAutenticado } from '@chamados/db';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ROTULO_PAPEL, iniciais } from '@/lib/rotulos';
import { acaoLogout } from '@/app/portal/actions';

/** Menu do usuário no header do portal: identidade + sair (specs/08 §3). */
export function UserMenu({ usuario }: { usuario: UsuarioAutenticado }) {
  return (
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
      <DropdownMenuContent align="end" className="w-60">
        <div className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="truncate text-sm font-medium">{usuario.nome}</span>
          <span className="truncate text-xs text-muted-foreground">{usuario.email}</span>
          <span className="mt-1 text-xs text-muted-foreground">{ROTULO_PAPEL[usuario.papel]}</span>
        </div>
        <DropdownMenuSeparator />
        <Link
          href="/portal/preferencias"
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
  );
}
