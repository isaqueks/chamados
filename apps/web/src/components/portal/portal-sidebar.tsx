'use client';

import { usePathname } from 'next/navigation';
import { Inbox, Plus, Bell } from 'lucide-react';
import { Marca } from '@/components/app-shell/marca';
import { LinhaNav } from '@/components/app-shell/nav-links';

/**
 * Sidebar do portal do cliente (specs/08 §3, pedida pelo usuário): mesma
 * superfície escura e linguagem visual da sidebar do painel (D-019 v2, D-009 —
 * consistência). Desktop only — no mobile o header compacto continua sendo a
 * navegação (portal é mobile-first, FAB/botão no header).
 */

const ITENS = [
  { href: '/portal', rotulo: 'Meus chamados', icone: Inbox },
  { href: '/portal/novo', rotulo: 'Abrir chamado', icone: Plus },
  { href: '/portal/preferencias', rotulo: 'Notificações', icone: Bell },
];

/** O detalhe do chamado (/portal/chamados/:id) pertence a "Meus chamados". */
function itemAtivo(pathname: string, href: string): boolean {
  if (href === '/portal') {
    return pathname === '/portal' || pathname.startsWith('/portal/chamados');
  }
  return pathname.startsWith(href);
}

export function PortalSidebar({
  tenantNome,
  logoUrl,
}: {
  tenantNome: string;
  logoUrl?: string | null;
}) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Marca tenantNome={tenantNome} logoUrl={logoUrl} />
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {ITENS.map((item) => (
          <LinhaNav key={item.href} item={item} ativo={itemAtivo(pathname, item.href)} />
        ))}
      </nav>
    </aside>
  );
}
