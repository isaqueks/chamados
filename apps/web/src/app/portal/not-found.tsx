import Link from 'next/link';
import { CircleHelp } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function NaoEncontrado() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <CircleHelp className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-semibold">Não encontramos este chamado</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Ele pode ter sido removido ou o endereço está incorreto.
        </p>
      </div>
      <Link href="/portal" className={cn(buttonVariants({ variant: 'outline' }))}>
        Voltar aos meus chamados
      </Link>
    </div>
  );
}
