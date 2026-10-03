import { CheckIcon, CircleIcon, MinusIcon, XIcon } from 'lucide-react';
import type { ChaveNoTrilha, EstadoNoTrilha, NoTrilhaDto } from '@comum/dto';
import { cn } from '@/lib/utils';

/**
 * Mini-trilha de uma linha do Lote (specs/forja/06 §4.5: "✓plano ✓impl
 * ●revisar ○relatar"). Cada nó tem ícone + texto — nunca só cor (06 §9). A
 * trilha completa, com duração e custo por nó, é a da tela de Execução.
 */

const ROTULO_CURTO: Record<ChaveNoTrilha, string> = {
  preparar: 'preparar',
  planejar: 'plano',
  decisao: 'decisão',
  implementar: 'impl',
  verificar: 'verif',
  revisar: 'revisar',
  relatar: 'relatar',
  aprovacao: 'aprovação',
  merge: 'merge',
  chamados: 'chamados',
};

const VISUAL: Record<EstadoNoTrilha, { icone: typeof CheckIcon; classe: string; sr: string }> = {
  feito: { icone: CheckIcon, classe: 'text-emerald-700 dark:text-emerald-400', sr: 'feito' },
  atual: {
    icone: CircleIcon,
    classe: 'text-violet-700 dark:text-violet-300 font-medium',
    sr: 'em andamento',
  },
  pendente: { icone: CircleIcon, classe: 'text-muted-foreground', sr: 'pendente' },
  falhou: { icone: XIcon, classe: 'text-rose-700 dark:text-rose-300 font-medium', sr: 'falhou' },
  pulado: { icone: MinusIcon, classe: 'text-muted-foreground/70 line-through', sr: 'pulado' },
};

export function MiniTrilha({ nos, className }: { nos: NoTrilhaDto[]; className?: string }) {
  // "preparar" e "chamados" são ruído numa linha de lote; aparecem só se falharam.
  const visiveis = nos.filter(
    (n) => (n.chave !== 'preparar' && n.chave !== 'chamados') || n.estado === 'falhou',
  );
  return (
    <ol className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs', className)}>
      {visiveis.map((n) => {
        const v = VISUAL[n.estado];
        const Icone = v.icone;
        return (
          <li key={n.chave} className={cn('flex items-center gap-0.5', v.classe)}>
            <Icone className={cn('size-3', n.estado === 'atual' && 'fill-current')} aria-hidden />
            <span>{ROTULO_CURTO[n.chave]}</span>
            <span className="sr-only">({v.sr})</span>
          </li>
        );
      })}
    </ol>
  );
}
