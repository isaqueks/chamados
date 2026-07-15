'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { Search } from 'lucide-react';

/**
 * Busca rápida da topbar (specs/08 §3): por número ou título (ILIKE — full-text
 * é M10). Submete navegando para a fila com `?q=`, onde a consulta é aplicada no
 * servidor. Progressive enhancement: também funciona como form nativo.
 */
export function BuscaRapida() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = ref.current?.value.trim() ?? '';
        router.push(q ? `/app/chamados?q=${encodeURIComponent(q)}` : '/app/chamados');
      }}
      className="relative w-full max-w-md"
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        name="q"
        type="search"
        placeholder="Buscar por número ou título…"
        aria-label="Buscar chamados"
        className="h-9 w-full rounded-md border border-input bg-transparent pr-3 pl-8 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </form>
  );
}
