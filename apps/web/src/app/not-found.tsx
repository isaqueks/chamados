import Link from 'next/link';
import { Compass } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 404 global (fallback fora das áreas). Amigável e brandado pelas CSS vars do tenant. */
export default function NaoEncontrado() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Compass className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Página não encontrada</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          O endereço que você tentou abrir não existe ou foi movido.
        </p>
      </div>
      <Link href="/" className={cn(buttonVariants({ variant: 'outline' }))}>
        Voltar ao início
      </Link>
    </main>
  );
}
