'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { acaoReexecutarTriagem } from '../actions';

/** Botão "Reexecutar triagem" (operador/admin — specs/05 §2, specs/08 §4.3). */
export function ReexecutarTriagem({ chamadoId }: { chamadoId: string }) {
  const [pendente, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pendente}
      onClick={() =>
        startTransition(async () => {
          const r = await acaoReexecutarTriagem(chamadoId);
          if (r.ok) toast.success(r.msg);
          else toast.error(r.msg);
        })
      }
    >
      <RefreshCw className={pendente ? 'size-4 animate-spin' : 'size-4'} />
      Reexecutar triagem
    </Button>
  );
}
