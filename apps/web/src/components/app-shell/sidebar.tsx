"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LayoutDashboard, Users } from "lucide-react"
import { Papel } from "@chamados/shared"
import { cn } from "@/lib/utils"

interface ItemNav {
  href: string
  rotulo: string
  icone: typeof LayoutDashboard
  /** Papéis que enxergam o item; vazio = todos. */
  papeis?: Papel[]
}

const ITENS: ItemNav[] = [
  { href: "/app", rotulo: "Painel", icone: LayoutDashboard },
  { href: "/app/usuarios", rotulo: "Usuários", icone: Users, papeis: [Papel.admin] },
]

export function Sidebar({
  papel,
  tenantNome,
}: {
  papel: Papel
  tenantNome: string
}) {
  const pathname = usePathname()
  const itens = ITENS.filter((i) => !i.papeis || i.papeis.includes(papel))

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
          {tenantNome.charAt(0).toUpperCase()}
        </div>
        <span className="truncate text-sm font-semibold">{tenantNome}</span>
      </div>
      <nav className="flex flex-col gap-1 p-2">
        {itens.map((item) => {
          const ativo =
            item.href === "/app"
              ? pathname === "/app"
              : pathname.startsWith(item.href)
          const Icone = item.icone
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                ativo
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Icone className="size-4" />
              {item.rotulo}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
