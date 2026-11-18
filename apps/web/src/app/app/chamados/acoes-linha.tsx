'use client';

import { useTransition } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { acaoAssumir } from './actions';

/**
 * Ação rápida de linha: atribuir o chamado a mim (specs/08 §4.4). `compacto`
 * (D-045) é a versão da célula "Responsável" da fila: botão pequeno, só ícone
 * em telas estreitas (o rótulo acessível continua "Assumir chamado").
 */
export function BotaoAssumir({
  chamadoId,
  compacto = false,
  className,
}: {
  chamadoId: string;
  compacto?: boolean;
  className?: string;
}) {
  const [pendente, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size={compacto ? 'xs' : 'sm'}
      disabled={pendente}
      aria-label={compacto ? 'Assumir chamado' : undefined}
      className={cn('shrink-0', className)}
      onClick={() =>
        startTransition(async () => {
          const r = await acaoAssumir(chamadoId);
          if (r.ok) toast.success(r.msg);
          else toast.error(r.msg);
        })
      }
    >
      <UserPlus className={compacto ? 'size-3' : 'size-3.5'} aria-hidden />
      <span className={cn(compacto && 'hidden sm:inline')}>
        {pendente ? 'Atribuindo…' : 'Assumir'}
      </span>
    </Button>
  );
}
