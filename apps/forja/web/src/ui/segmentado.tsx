import { cn } from '@/lib/utils';

/**
 * Alternador segmentado (2–3 opções exclusivas, ex.: "Lado a lado | Unificado"):
 * botões com `aria-pressed` num trilho `muted`. Único no design system para
 * não haver cópias divergentes por tela (D-009).
 */
function Segmentado<V extends string>({
  valor,
  aoMudar,
  opcoes,
  rotuloAcessivel,
  className,
}: {
  valor: V;
  aoMudar: (valor: V) => void;
  opcoes: readonly (readonly [V, string])[];
  rotuloAcessivel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={rotuloAcessivel}
      data-slot="segmentado"
      className={cn('inline-flex rounded-lg bg-muted p-[3px]', className)}
    >
      {opcoes.map(([v, rotulo]) => (
        <button
          key={v}
          type="button"
          aria-pressed={valor === v}
          onClick={() => aoMudar(v)}
          className={cn(
            'rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            valor === v && 'bg-background text-foreground shadow-sm',
          )}
        >
          {rotulo}
        </button>
      ))}
    </div>
  );
}

export { Segmentado };
