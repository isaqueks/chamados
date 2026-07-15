import { cva, type VariantProps } from 'class-variance-authority';
import { StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import { cn } from '@/lib/utils';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from '@/lib/rotulos';

/**
 * Módulo ÚNICO de badges do domínio Chamado (specs/08, D-009: consistência). É a
 * fonte da verdade visual de status/prioridade/complexidade/natureza, reutilizada
 * na fila, no detalhe e no dashboard. Distinção NUNCA depende só de cor: todo badge
 * carrega rótulo textual (acessibilidade — specs/08 §6). Complexidade é interna:
 * só renderize em superfícies de operador/admin.
 */

const baseBadge =
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap w-fit';

// --- Status -----------------------------------------------------------------

const statusBadge = cva(baseBadge, {
  variants: {
    tom: {
      sky: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
      violet:
        'border-transparent bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
      amber:
        'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      indigo:
        'border-transparent bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
      emerald:
        'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
      neutral: 'border-transparent bg-muted text-muted-foreground',
    },
  },
  defaultVariants: { tom: 'neutral' },
});

type Tom = NonNullable<VariantProps<typeof statusBadge>['tom']>;

const TOM_STATUS: Record<StatusChamado, Tom> = {
  [StatusChamado.novo]: 'sky',
  [StatusChamado.em_triagem]: 'violet',
  [StatusChamado.aguardando_cliente]: 'amber',
  [StatusChamado.em_atendimento]: 'indigo',
  [StatusChamado.resolvido]: 'emerald',
  [StatusChamado.fechado]: 'neutral',
  [StatusChamado.cancelado]: 'neutral',
};

const PONTO_STATUS: Record<Tom, string> = {
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  amber: 'bg-amber-500',
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  neutral: 'bg-muted-foreground/50',
};

export function StatusBadge({ status, className }: { status: StatusChamado; className?: string }) {
  const tom = TOM_STATUS[status];
  return (
    <span className={cn(statusBadge({ tom }), className)}>
      <span className={cn('size-1.5 rounded-full', PONTO_STATUS[tom])} aria-hidden />
      {ROTULO_STATUS_CHAMADO[status]}
    </span>
  );
}

// --- Prioridade -------------------------------------------------------------

const prioridadeBadge = cva(baseBadge, {
  variants: {
    prioridade: {
      baixa: 'border-transparent bg-muted text-muted-foreground',
      media: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      alta: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
      urgente: 'border-transparent bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    },
  },
  defaultVariants: { prioridade: 'media' },
});

const PONTO_PRIORIDADE: Record<Prioridade, string> = {
  [Prioridade.baixa]: 'bg-muted-foreground/40',
  [Prioridade.media]: 'bg-slate-400',
  [Prioridade.alta]: 'bg-amber-500',
  [Prioridade.urgente]: 'bg-red-500',
};

export function PrioridadeBadge({
  prioridade,
  className,
}: {
  prioridade: Prioridade;
  className?: string;
}) {
  return (
    <span className={cn(prioridadeBadge({ prioridade }), className)}>
      <span className={cn('size-1.5 rounded-full', PONTO_PRIORIDADE[prioridade])} aria-hidden />
      {ROTULO_PRIORIDADE[prioridade]}
    </span>
  );
}

// --- Complexidade (interna) -------------------------------------------------

const complexidadeBadge = cva(baseBadge, {
  variants: {
    complexidade: {
      facil:
        'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
      medio:
        'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      dificil: 'border-transparent bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
    },
  },
  defaultVariants: { complexidade: 'medio' },
});

export function ComplexidadeBadge({
  complexidade,
  className,
}: {
  complexidade: Complexidade;
  className?: string;
}) {
  return (
    <span className={cn(complexidadeBadge({ complexidade }), className)}>
      {ROTULO_COMPLEXIDADE[complexidade]}
    </span>
  );
}

// --- Natureza ---------------------------------------------------------------

export function NaturezaBadge({ natureza, className }: { natureza: Natureza; className?: string }) {
  return (
    <span className={cn(baseBadge, 'border-border text-foreground', className)}>
      {ROTULO_NATUREZA[natureza]}
    </span>
  );
}

// --- Nota interna -----------------------------------------------------------

/** Selo textual de nota interna (fundo âmbar — specs/08 §4.3). */
export function NotaInternaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        baseBadge,
        'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300',
        className,
      )}
    >
      Nota interna
    </span>
  );
}
