'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { acaoMapearSistema } from '../actions';

/**
 * Botão "Mapear agora" (admin — D-013): enfileira o mapeamento de conhecimento do
 * sistema-alvo. Estado de carregamento + toast, no padrão de `ReexecutarTriagem`.
 */
export function MapearSistema({ sistemaAlvoId }: { sistemaAlvoId: string }) {
  const [pendente, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pendente}
      onClick={() =>
        startTransition(async () => {
          const r = await acaoMapearSistema(sistemaAlvoId);
          if (r.ok) toast.success(r.msg);
          else toast.error(r.msg);
        })
      }
    >
      <Brain className={pendente ? 'size-4 animate-pulse' : 'size-4'} />
      Mapear agora
    </Button>
  );
}
