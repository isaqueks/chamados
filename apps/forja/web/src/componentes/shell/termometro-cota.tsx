import type { CotaDto } from '@comum/dto';
import {
  formatarPercentual,
  horaLocal,
  medicaoRecente,
  tomCota,
  type TomCota,
} from '@/lib/formato';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

/**
 * Termômetro de cota (specs/forja/06 §1.2): `5h 23%` e `7d 41%` do último
 * `rate_limit_event`. Neutro abaixo de (limiar − 10 pp), âmbar até o limiar,
 * vermelho no limiar com "freio ativo". Sem medição há 30 min: esmaecido.
 * Nunca só cor: a porcentagem está sempre escrita.
 */

const COR_BARRA: Record<TomCota, string> = {
  neutro: 'bg-muted-foreground/60',
  ambar: 'bg-amber-500',
  vermelho: 'bg-rose-500',
};

function Barra({
  rotulo,
  utilizacao,
  limiar,
}: {
  rotulo: string;
  utilizacao: number | null;
  limiar: number;
}) {
  const valor = utilizacao ?? 0;
  const tom = tomCota(valor, limiar);
  return (
    <span className="flex items-center gap-1.5 text-xs tabular-nums">
      <span className="text-muted-foreground">{rotulo}</span>
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', COR_BARRA[tom])}
          style={{ width: `${Math.min(100, valor * 100)}%` }}
        />
      </span>
      <span className={cn(tom === 'vermelho' && 'font-semibold text-rose-600 dark:text-rose-400')}>
        {utilizacao === null ? '—' : formatarPercentual(valor)}
      </span>
    </span>
  );
}

export function TermometroCota({ cota }: { cota: CotaDto | null }) {
  const recente = medicaoRecente(cota?.medido_em ?? null);
  const conteudo = (
    <span
      className={cn('flex items-center gap-3', !recente && 'opacity-50')}
      aria-label="Cota da assinatura"
    >
      <Barra rotulo="5h" utilizacao={cota?.utilizacao_5h ?? null} limiar={cota?.limiar_5h ?? 0.8} />
      <Barra rotulo="7d" utilizacao={cota?.utilizacao_7d ?? null} limiar={cota?.limiar_7d ?? 0.9} />
      {cota?.usando_creditos_extras && (
        <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          usando créditos extras
        </span>
      )}
    </span>
  );

  const reinicio5h = horaLocal(cota?.reinicia_5h_em ?? null);
  const freioAte = horaLocal(cota?.freio.ate ?? null);
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>{conteudo}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start">
        {!cota || !cota.medido_em ? (
          <span>Sem medição: a cota só é lida quando algum claude roda.</span>
        ) : (
          <>
            {reinicio5h && <span>Janela de 5 h reinicia às {reinicio5h}</span>}
            <span>{recente ? 'Medição recente' : 'Sem medição recente'}</span>
            {cota.freio.ativo && (
              <span>
                Freio ativo{freioAte ? `: novas etapas aguardam até ${freioAte}` : ''}
                {cota.freio.motivo ? ` (${cota.freio.motivo})` : ''}
              </span>
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
