import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Select NATIVO do design system (equivalente ao `native-select` do shadcn):
 * mesma superfície do `Input`/`SelectTrigger` (`bg-card`, `shadow-campo`, ring
 * de foco — "campo é campo", D-030), com o `<select>` do navegador por baixo.
 * Use dentro de superfícies flutuantes (popover de filtros — D-045) e em
 * formulários simples: teclado, leitor de tela e mobile nativos, sem popup
 * aninhado. `className` vai no invólucro (largura); o resto, no `<select>`.
 */
function NativeSelect({
  className,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }) {
  return (
    <div
      data-slot="native-select-wrapper"
      className={cn(
        'group/native-select relative w-fit has-[select:disabled]:opacity-50',
        className,
      )}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          'w-full min-w-0 appearance-none rounded-lg border border-input bg-card pr-8 pl-2.5 text-sm shadow-campo transition-[color,box-shadow] outline-none select-none',
          'hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'data-[size=default]:h-9 data-[size=sm]:h-8',
          'dark:bg-input/30 dark:hover:bg-input/50 [&_option]:bg-popover [&_option]:text-popover-foreground',
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden
      />
    </div>
  );
}

export { NativeSelect };
