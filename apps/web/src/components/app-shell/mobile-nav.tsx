'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Papel } from '@chamados/shared';
import { buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Marca } from './marca';
import { NavLinks } from './nav-links';

/**
 * Navegação mobile: hambúrguer na topbar abre um sheet lateral com os mesmos
 * links da sidebar (specs/08 §3 — sidebar → sheet no mobile). Fecha ao navegar.
 */
export function MobileNav({
  papel,
  tenantNome,
  logoUrl,
}: {
  papel: Papel;
  tenantNome: string;
  logoUrl?: string | null;
}) {
  const [aberto, setAberto] = useState(false);

  return (
    <Sheet open={aberto} onOpenChange={setAberto}>
      <SheetTrigger
        aria-label="Abrir navegação"
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'md:hidden')}
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0">
        <SheetHeader className="h-14 justify-center border-b px-4">
          <SheetTitle className="text-left">
            <Marca tenantNome={tenantNome} logoUrl={logoUrl} />
          </SheetTitle>
        </SheetHeader>
        <div className="p-2">
          <NavLinks papel={papel} onNavigate={() => setAberto(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
