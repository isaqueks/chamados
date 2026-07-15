'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Boundary de erro do portal do cliente — linguagem simples, sem jargão técnico. */
export default function ErroPortal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <TriangleAlert className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Algo deu errado</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Tivemos um problema ao abrir esta página. Tente de novo em instantes.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={reset}>
          Tentar novamente
        </Button>
        <Link href="/portal" className={cn(buttonVariants({ variant: 'ghost' }))}>
          Meus chamados
        </Link>
      </div>
    </div>
  );
}
