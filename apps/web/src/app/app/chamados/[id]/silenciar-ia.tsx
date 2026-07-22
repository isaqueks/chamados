'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { BellOff, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { acaoSilenciarIa } from '../actions';

/**
 * Botão "Silenciar IA"/"Reativar IA" (operador/admin — D-024, specs/05 §2).
 * Silenciada, nenhuma triagem roda no chamado até um humano reativar.
 */
export function SilenciarIa({ chamadoId, silenciada }: { chamadoId: string; silenciada: boolean }) {
  const [pendente, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pendente}
      onClick={() =>
        startTransition(async () => {
          const r = await acaoSilenciarIa(chamadoId, !silenciada);
          if (r.ok) toast.success(r.msg);
          else toast.error(r.msg);
        })
      }
    >
      {silenciada ? <Bell className="size-4" /> : <BellOff className="size-4" />}
      {silenciada ? 'Reativar IA' : 'Silenciar IA'}
    </Button>
  );
}
