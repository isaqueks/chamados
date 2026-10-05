import { CameraIcon, CheckIcon, CircleIcon, GitMergeIcon, MinusIcon, XIcon } from 'lucide-react';
import type { EstadoNoTrilha, NoTrilhaDto } from '@comum/dto';
import { EstadoExecucaoBadge } from '@/componentes/badges';
import { formatarCustoEquivalente } from '@/lib/formato';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  ROTULO_ESTADO_NO,
  ROTULO_NO_TRILHA,
  formatarDuracao,
  nomeModelo,
} from './formato-execucao';

/**
 * Trilha de etapas (specs/forja/06 §4.2): Preparar → Planejar → (Decisão) →
 * Implementar → Coleta → Revisar → Relatar → Aprovação → Merge → Chamados.
 * Cada nó mostra a duração; no hover, o custo e o modelo. Com o badge `UI`,
 * Implementar e Coleta ganham os sub-nós "prints antes"/"prints depois"
 * (FJ-026, 03 §5.4) com o resultado no hover; o Merge ganha "Resolvendo
 * conflito com <destino>" quando o agente resolve um conflito (FJ-036). Os estados laterais (pausado,
 * cota, assumido) aparecem como selo sobre o nó atual. O estado de cada nó é
 * ícone + texto acessível (nunca só cor); sem animação com
 * `prefers-reduced-motion` (regra global).
 */

const ICONE_NO: Record<EstadoNoTrilha, typeof CheckIcon> = {
  feito: CheckIcon,
  atual: CircleIcon,
  pendente: CircleIcon,
  falhou: XIcon,
  pulado: MinusIcon,
};

const CLASSE_NO: Record<EstadoNoTrilha, string> = {
  feito: 'text-emerald-700 dark:text-emerald-300',
  atual: 'text-violet-700 dark:text-violet-300 font-semibold',
  pendente: 'text-muted-foreground',
  falhou: 'text-rose-700 dark:text-rose-300',
  pulado: 'text-muted-foreground/70 line-through',
};

const ROTULO_SUBNO = {
  prints_antes: 'prints antes',
  prints_depois: 'prints depois',
  resolver_conflito: 'resolvendo conflito',
} as const;

export function TrilhaEtapas({
  nos,
  marcadorCiclos,
}: {
  nos: NoTrilhaDto[];
  marcadorCiclos?: string | null;
}) {
  if (nos.length === 0) return null;
  return (
    <nav aria-label="Etapas da execução" className="flex flex-col gap-1">
      <ol className="flex flex-wrap items-start gap-x-1 gap-y-2 text-sm">
        {nos.map((no, i) => {
          const Icone = ICONE_NO[no.estado];
          const duracao = formatarDuracao(no.duracao_ms);
          const detalhes = [
            ROTULO_ESTADO_NO[no.estado],
            duracao,
            no.custo_micro_usd !== null ? formatarCustoEquivalente(no.custo_micro_usd) : null,
            nomeModelo(no.modelo),
          ].filter(Boolean);
          return (
            <li
              key={no.chave}
              className="flex items-start gap-1"
              aria-current={no.estado === 'atual' ? 'step' : undefined}
            >
              {i > 0 && <span aria-hidden className="mt-2.5 h-px w-3 bg-border" />}
              <div className="flex flex-col items-start gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        tabIndex={0}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          no.estado === 'atual' && 'bg-violet-50 dark:bg-violet-950/50',
                          CLASSE_NO[no.estado],
                        )}
                      />
                    }
                  >
                    <Icone
                      className={cn(
                        'size-3.5',
                        no.estado === 'atual' && 'animate-pulse fill-current',
                      )}
                      aria-hidden
                    />
                    {ROTULO_NO_TRILHA[no.chave]}
                    <span className="sr-only">: {ROTULO_ESTADO_NO[no.estado]}</span>
                    {duracao && (
                      <span className="text-xs font-normal text-muted-foreground">{duracao}</span>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>{detalhes.join(' · ')}</TooltipContent>
                </Tooltip>
                {no.lateral && (
                  <EstadoExecucaoBadge estado={no.lateral} className="text-[0.7rem]" />
                )}
                {no.subnos.length > 0 && (
                  <ul className="flex flex-col gap-0.5 pl-2">
                    {no.subnos.map((s) => {
                      const SubIcone = ICONE_NO[s.estado];
                      return (
                        <li key={s.chave}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  tabIndex={0}
                                  className={cn(
                                    'inline-flex items-center gap-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                                    CLASSE_NO[s.estado],
                                  )}
                                />
                              }
                            >
                              {s.chave === 'resolver_conflito' ? (
                                <GitMergeIcon className="size-3" aria-hidden />
                              ) : (
                                <CameraIcon className="size-3" aria-hidden />
                              )}
                              {s.chave === 'resolver_conflito'
                                ? (s.detalhe ?? ROTULO_SUBNO[s.chave])
                                : ROTULO_SUBNO[s.chave]}
                              <SubIcone className="size-3" aria-hidden />
                              <span className="sr-only">: {ROTULO_ESTADO_NO[s.estado]}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {s.detalhe ?? ROTULO_ESTADO_NO[s.estado]}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {marcadorCiclos && <p className="text-xs text-muted-foreground">{marcadorCiclos}</p>}
    </nav>
  );
}
