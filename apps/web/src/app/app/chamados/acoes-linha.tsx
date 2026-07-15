'use client';

import { useTransition } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { acaoAssumir } from './actions';

/** Ação rápida de linha: atribuir o chamado a mim (specs/08 §4.4). */
export function BotaoAssumir({ chamadoId }: { chamadoId: string }) {
  const [pendente, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pendente}
      onClick={() =>
        startTransition(async () => {
          const r = await acaoAssumir(chamadoId);
          if (r.ok) toast.success(r.msg);
          else toast.error(r.msg);
        })
      }
    >
      <UserPlus className="size-3.5" />
      {pendente ? 'Atribuindo…' : 'Assumir'}
    </Button>
  );
}
