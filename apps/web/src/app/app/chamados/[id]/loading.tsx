import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton do detalhe do chamado (specs/08 §6). */
export default function CarregandoDetalhe() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <Skeleton className="h-4 w-28" />
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_336px]">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
