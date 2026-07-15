'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Ticket,
  Users,
  Server,
  Tags,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { Papel } from '@chamados/shared';
import { cn } from '@/lib/utils';

interface ItemNav {
  href: string;
  rotulo: string;
  icone: LucideIcon;
  /** Papéis que enxergam o item; ausente = todos da equipe. */
  papeis?: Papel[];
}

/** Navegação principal (operador + admin). */
const PRINCIPAIS: ItemNav[] = [
  { href: '/app', rotulo: 'Dashboard', icone: LayoutDashboard },
  { href: '/app/chamados', rotulo: 'Chamados', icone: Ticket },
];

/** Administração do tenant (só admin — specs/03 §8.2). */
const ADMIN: ItemNav[] = [
  { href: '/app/usuarios', rotulo: 'Usuários', icone: Users, papeis: [Papel.admin] },
  { href: '/app/sistemas', rotulo: 'Sistemas-alvo', icone: Server, papeis: [Papel.admin] },
  { href: '/app/categorias', rotulo: 'Categorias', icone: Tags, papeis: [Papel.admin] },
  { href: '/app/config', rotulo: 'Configurações', icone: Settings, papeis: [Papel.admin] },
];

function itemAtivo(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname.startsWith(href);
}

function LinhaNav({
  item,
  ativo,
  onNavigate,
}: {
  item: ItemNav;
  ativo: boolean;
  onNavigate?: () => void;
}) {
  const Icone = item.icone;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={ativo ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        ativo
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
      )}
    >
      <Icone className="size-4 shrink-0" />
      {item.rotulo}
    </Link>
  );
}

/** Links de navegação reutilizados pela sidebar (desktop) e pelo sheet (mobile). */
export function NavLinks({ papel, onNavigate }: { papel: Papel; onNavigate?: () => void }) {
  const pathname = usePathname();
  const admin = ADMIN.filter((i) => !i.papeis || i.papeis.includes(papel));

  return (
    <nav className="flex flex-col gap-1">
      {PRINCIPAIS.map((item) => (
        <LinhaNav
          key={item.href}
          item={item}
          ativo={itemAtivo(pathname, item.href)}
          onNavigate={onNavigate}
        />
      ))}

      {admin.length > 0 && (
        <>
          <p className="mt-4 mb-1 px-3 text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
            Administração
          </p>
          {admin.map((item) => (
            <LinhaNav
              key={item.href}
              item={item}
              ativo={itemAtivo(pathname, item.href)}
              onNavigate={onNavigate}
            />
          ))}
        </>
      )}
    </nav>
  );
}
