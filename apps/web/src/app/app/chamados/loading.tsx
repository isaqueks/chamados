import { Skeleton } from '@/components/ui/skeleton';

/**
 * Skeleton da fila (specs/08 §6 — nada em branco), com a MESMA estrutura da
 * página (D-045): cabeçalho com ações, um cartão com barra de ferramentas,
 * linhas de duas alturas (título + solicitante) e rodapé de paginação.
 */
export default function CarregandoFila() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5" aria-busy="true">
      <span className="sr-only">Carregando chamados…</span>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-cartao">
        <div className="flex flex-col gap-3 border-b p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Skeleton className="h-9 w-full rounded-lg sm:w-80" />
            <Skeleton className="h-8 w-full lg:w-72 xl:w-80" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="ml-auto hidden h-7 w-48 sm:block" />
          </div>
        </div>

        {/* Cabeçalho da tabela (≥ xl) */}
        <div className="hidden items-center gap-4 border-b bg-muted/40 px-4 py-2.5 xl:flex">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-14" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-3 py-3 last:border-0 sm:px-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="hidden h-5 w-24 xl:block" />
            <Skeleton className="hidden h-5 w-16 xl:block" />
            <div className="hidden w-40 items-center gap-2 xl:flex">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
        <div className="flex items-center justify-between border-t px-3 py-2.5 sm:px-4">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-48" />
        </div>
      </div>
    </div>
  );
}
