import type { StatusChamado, Natureza, Prioridade } from '@chamados/shared';
import { Badge } from '@/components/ui/badge';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  VARIANTE_STATUS,
} from '@/lib/rotulos';

/** Badge de status do chamado, com variante coerente ao ciclo de vida (specs/04 §1). */
export function StatusBadge({ status }: { status: StatusChamado }) {
  return <Badge variant={VARIANTE_STATUS[status]}>{ROTULO_STATUS_CHAMADO[status]}</Badge>;
}

/** Badge de natureza (problema/alteração). */
export function NaturezaBadge({ natureza }: { natureza: Natureza }) {
  return <Badge variant="outline">{ROTULO_NATUREZA[natureza]}</Badge>;
}

/** Badge de prioridade (visível ao cliente — specs/04 §3.2). */
export function PrioridadeBadge({ prioridade }: { prioridade: Prioridade }) {
  return <Badge variant="muted">Prioridade: {ROTULO_PRIORIDADE[prioridade]}</Badge>;
}
