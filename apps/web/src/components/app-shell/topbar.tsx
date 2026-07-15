import { LogOut } from 'lucide-react';
import type { UsuarioAutenticado } from '@chamados/db';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ROTULO_PAPEL, iniciais } from '@/lib/rotulos';
import { acaoLogout } from '@/app/app/actions';

export function Topbar({ usuario }: { usuario: UsuarioAutenticado }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background px-4">
      <div className="flex items-center gap-2 md:hidden">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
          C
        </div>
        <span className="text-sm font-semibold">Chamados</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {iniciais(usuario.nome)}
          </div>
          <div className="hidden flex-col leading-tight sm:flex">
            <span className="text-sm font-medium">{usuario.nome}</span>
            <span className="text-xs text-muted-foreground">{usuario.email}</span>
          </div>
          <Badge variant="secondary">{ROTULO_PAPEL[usuario.papel]}</Badge>
        </div>

        <form action={acaoLogout}>
          <Button type="submit" variant="ghost" size="sm" aria-label="Sair">
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sair</span>
          </Button>
        </form>
      </div>
    </header>
  );
}
