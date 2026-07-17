import { Papel } from '@chamados/shared';
import { Marca } from './marca';
import { NavLinks } from './nav-links';

/**
 * Sidebar do painel (desktop). Navegação por papel via `NavLinks`. No mobile ela
 * some e dá lugar ao sheet acionado pela topbar (specs/08 §3 — responsivo).
 */
export function Sidebar({
  papel,
  tenantNome,
  logoUrl,
}: {
  papel: Papel;
  tenantNome: string;
  logoUrl?: string | null;
}) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Marca tenantNome={tenantNome} logoUrl={logoUrl} />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <NavLinks papel={papel} />
      </div>
    </aside>
  );
}
