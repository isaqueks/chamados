import { Link } from 'react-router';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CircleIcon, MinusIcon, XIcon } from 'lucide-react';
import type { EstadoNoTrilha, ItemFilaMergeDto } from '@comum/dto';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { shaCurto } from '@/componentes/apoio/texto';
import { itemEmProcessamento, ROTULO_ESTADO_ITEM, ROTULO_PASSO_INTEGRACAO } from './logica';

/**
 * Linha da fila serial de merge (specs/forja/06 §4.6): posição, chamado,
 * `patch-id` aprovado, estado e a sub-trilha da integração (integrar →
 * reverificar → conferir patch-id → avançar a ref por CAS → push, F-10).
 * Cada passo leva ícone + texto (nunca só cor, 06 §9).
 */

const ICONE_PASSO: Record<EstadoNoTrilha, { icone: typeof CheckIcon; classe: string }> = {
  feito: { icone: CheckIcon, classe: 'text-emerald-700 dark:text-emerald-400' },
  atual: { icone: CircleIcon, classe: 'text-violet-700 dark:text-violet-300 font-medium' },
  pendente: { icone: CircleIcon, classe: 'text-muted-foreground' },
  falhou: { icone: XIcon, classe: 'text-rose-700 dark:text-rose-300 font-medium' },
  pulado: { icone: MinusIcon, classe: 'text-muted-foreground/70' },
};

export function ItemFilaMerge({
  item,
  posicao,
  podeSubir,
  podeDescer,
  aoMover,
  movendo,
}: {
  item: ItemFilaMergeDto;
  posicao: number;
  podeSubir: boolean;
  podeDescer: boolean;
  aoMover: ((direcao: 'subir' | 'descer') => void) | null;
  movendo: boolean;
}) {
  const processando = itemEmProcessamento(item);
  const problema = item.estado === 'conflito' || item.estado === 'devolvido';
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 px-4 py-3',
        processando && 'bg-violet-50/50 dark:bg-violet-950/20',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-5 text-right text-sm text-muted-foreground tabular-nums">{posicao}</span>
        <Link
          to={`/execucoes/${item.execucao_id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          title={item.titulo}
        >
          <span className="tabular-nums">#{item.numero}</span> {item.titulo}
        </Link>
        <span className="font-mono text-xs text-muted-foreground" title={item.patch_id}>
          patch {shaCurto(item.patch_id, 6)}
        </span>
        <span
          className={cn(
            'text-xs font-medium',
            processando && 'text-violet-700 dark:text-violet-300',
            problema && 'text-rose-700 dark:text-rose-300',
          )}
        >
          {ROTULO_ESTADO_ITEM[item.estado]}
          {processando && item.sha_destino_antes
            ? ` sobre ${shaCurto(item.sha_destino_antes)}`
            : ''}
        </span>
        {aoMover && (
          <span className="flex gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Subir #${item.numero} na fila`}
              disabled={!podeSubir || movendo}
              onClick={() => aoMover('subir')}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Descer #${item.numero} na fila`}
              disabled={!podeDescer || movendo}
              onClick={() => aoMover('descer')}
            >
              <ArrowDownIcon />
            </Button>
          </span>
        )}
      </div>
      {(processando || problema) && item.passos.length > 0 && (
        <ol className="ml-8 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {item.passos.map((p) => {
            const v = ICONE_PASSO[p.estado];
            const Icone = v.icone;
            return (
              <li key={p.chave} className={cn('flex items-center gap-1', v.classe)}>
                <Icone
                  className={cn('size-3', p.estado === 'atual' && 'fill-current')}
                  aria-hidden
                />
                {ROTULO_PASSO_INTEGRACAO[p.chave]}
                {p.detalhe ? <span className="text-muted-foreground">({p.detalhe})</span> : null}
              </li>
            );
          })}
        </ol>
      )}
      {item.motivo && (
        <p
          className={cn(
            'ml-8 text-xs',
            problema ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground',
          )}
        >
          {item.motivo}
        </p>
      )}
      {item.copia_local_atras && (
        <p className="ml-8 text-xs text-muted-foreground">
          Depois deste merge, sua cópia local da branch de destino fica atrás do remoto.
        </p>
      )}
    </li>
  );
}
