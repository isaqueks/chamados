import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 404 do painel (operador/admin) — dentro do shell, brandado pelo tenant (specs/08 §7). */
export default function NaoEncontrado() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <SearchX className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Não encontramos esta página
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          O chamado ou recurso pode ter sido removido, ou o endereço está incorreto.
        </p>
      </div>
      <Link href="/app" className={cn(buttonVariants({ variant: 'outline' }))}>
        Voltar ao painel
      </Link>
    </div>
  );
}
