import { NavLink, useLocation } from 'react-router';
import { HammerIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import type { ContadoresSidebarDto } from '@comum/dto';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ITENS_NAV, itemAtivo, type ItemNav } from './itens-nav';

/**
 * Sidebar ESCURA nos dois temas (D-019, specs/forja/06 §1.1): mesma linguagem
 * do painel do Chamados (item ativo com fundo realçado + barra de acento
 * derivada de --primary clareada). Colapsa para ícones com tooltip.
 */

function LinhaNav({
  item,
  ativo,
  recolhida,
  contadores,
}: {
  item: ItemNav;
  ativo: boolean;
  recolhida: boolean;
  contadores: ContadoresSidebarDto | null;
}) {
  const Icone = item.icone;
  const contador = contadores && item.contador ? item.contador(contadores) : 0;
  const alerta = contadores && item.alerta ? item.alerta(contadores) : false;

  const link = (
    <NavLink
      to={item.href}
      aria-current={ativo ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        recolhida && 'justify-center px-2',
        ativo
          ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:top-1/2 before:left-0 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-[color-mix(in_oklab,var(--primary),white_45%)] [&_svg]:text-[color-mix(in_oklab,var(--primary),white_45%)]'
          : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <span className="relative">
        <Icone className="size-4 shrink-0 transition-colors" />
        {alerta && (
          <span
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-rose-500 ring-2 ring-sidebar"
            aria-label="requer atenção"
          />
        )}
      </span>
      {!recolhida && <span className="flex-1">{item.rotulo}</span>}
      {!recolhida && contador > 0 && (
        <span className="rounded-full bg-sidebar-accent px-1.5 text-xs tabular-nums text-sidebar-foreground/80">
          {contador}
        </span>
      )}
    </NavLink>
  );

  if (!recolhida) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">
        {item.rotulo}
        {contador > 0 ? ` (${contador})` : ''}
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  contadores,
  recolhida,
  alternar,
}: {
  contadores: ContadoresSidebarDto | null;
  recolhida: boolean;
  alternar: () => void;
}) {
  const { pathname } = useLocation();
  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width]',
        recolhida ? 'w-14' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-sidebar-border px-4',
          recolhida && 'justify-center px-2',
        )}
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <HammerIcon className="size-4" aria-hidden />
        </span>
        {!recolhida && <span className="text-sm font-semibold tracking-tight">Forja</span>}
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Navegação">
        {ITENS_NAV.map((item) => (
          <LinhaNav
            key={item.href}
            item={item}
            ativo={itemAtivo(pathname, item)}
            recolhida={recolhida}
            contadores={contadores}
          />
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={alternar}
          className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          aria-label={recolhida ? 'Expandir a barra lateral' : 'Recolher a barra lateral'}
        >
          {recolhida ? (
            <PanelLeftOpenIcon className="size-4" />
          ) : (
            <>
              <PanelLeftCloseIcon className="size-4" />
              <span className="flex-1 text-left">Recolher</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
