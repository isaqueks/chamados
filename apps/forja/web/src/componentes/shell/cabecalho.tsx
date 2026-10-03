import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { DiamondIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import type { PendenciaDto, ShellDto, TipoPendencia } from '@comum/dto';
import { api } from '@/lib/api';
import type { EstadoConexaoSse } from '@/lib/sse';
import { formatarCustoEquivalente } from '@/lib/formato';
import { useTema, type Tema } from '@/lib/tema';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useProjetoAtual } from './projeto-atual';
import { TermometroCota } from './termometro-cota';

/**
 * Cabeçalho fixo (specs/forja/06 §1.2), da esquerda para a direita: seletor de
 * projeto, termômetro de cota, custo do dia (clicável: detalhe por execução e
 * por modelo via `uso_obter`), "Aguardando você (N)", tema e o indicador do
 * stream (cor + texto "reconectando": nunca só cor, 06 §9).
 */

const ROTULO_PENDENCIA: Record<TipoPendencia, string> = {
  aprovar: 'aprovar',
  decidir_plano: 'decidir plano',
  decisao: 'decisão necessária',
  pergunta_respondida: 'pergunta respondida',
  precisa_de_voce: 'precisa de você',
  outbox_falhou: 'outbox falhou',
};

function SeletorProjeto({ projetos }: { projetos: ShellDto['projetos'] }) {
  const { projetoId, definirProjeto } = useProjetoAtual();
  const atual = projetos.find((p) => p.id === projetoId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
        {atual?.nome ?? (projetos.length ? 'Todos os projetos' : 'Nenhum projeto')}
        <span className="text-muted-foreground" aria-hidden>
          ▾
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup
          value={projetoId ?? ''}
          onValueChange={(v: string) => definirProjeto(v || null)}
        >
          <DropdownMenuRadioItem value="">Todos os projetos</DropdownMenuRadioItem>
          {projetos.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.nome}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/projetos" />}>Configurar projetos…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AguardandoVoce({ pendencias }: { pendencias: PendenciaDto[] }) {
  const n = pendencias.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
          n > 0
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300'
            : 'border-border text-muted-foreground hover:bg-muted',
        )}
        aria-label={`Aguardando você: ${n}`}
      >
        <DiamondIcon className={cn('size-3.5', n > 0 && 'fill-current')} aria-hidden />
        Aguardando você ({n})
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Aguardando você</DropdownMenuLabel>
        {n === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Nada esperando por você agora.</p>
        ) : (
          pendencias.map((p) => (
            <DropdownMenuItem key={`${p.execucao_id}:${p.tipo}`} render={<Link to={p.href} />}>
              <span className="font-medium tabular-nums">#{p.numero}</span>
              <span className="flex-1 truncate">{p.titulo}</span>
              <span className="text-xs text-muted-foreground">{ROTULO_PENDENCIA[p.tipo]}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ICONE_TEMA: Record<Tema, typeof SunIcon> = {
  claro: SunIcon,
  escuro: MoonIcon,
  sistema: MonitorIcon,
};

function SeletorTema() {
  const { tema, definirTema } = useTema();
  const Icone = ICONE_TEMA[tema];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Tema"
      >
        <Icone className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup value={tema} onValueChange={(v: string) => definirTema(v as Tema)}>
          <DropdownMenuRadioItem value="claro">Claro</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="escuro">Escuro</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="sistema">Sistema</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IndicadorStream({ estado }: { estado: EstadoConexaoSse }) {
  const conectado = estado === 'conectado';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="flex h-8 min-w-8 items-center justify-center gap-1.5 px-1 text-xs text-amber-800 dark:text-amber-300"
          />
        }
      >
        <span
          role="img"
          className={cn('size-2 rounded-full', conectado ? 'bg-emerald-500' : 'bg-amber-500')}
          aria-label={conectado ? 'stream conectado' : 'stream reconectando'}
        />
        {!conectado && <span aria-hidden>reconectando</span>}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {conectado ? 'Atualizações ao vivo conectadas' : 'Reconectando às atualizações…'}
      </TooltipContent>
    </Tooltip>
  );
}

/** Custo do dia (06 §1.2 item 3): clicar abre o detalhe por execução e por modelo. */
function CustoDia({ microUsd }: { microUsd: number }) {
  const [aberto, setAberto] = useState(false);
  const uso = useQuery({
    queryKey: ['uso'],
    queryFn: ({ signal }) => api('uso_obter', { sinal: signal }),
    enabled: aberto,
    staleTime: 15_000,
  });
  return (
    <DropdownMenu open={aberto} onOpenChange={setAberto}>
      <DropdownMenuTrigger
        className="rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`Custo do dia: ${formatarCustoEquivalente(microUsd)}. Abrir detalhe`}
      >
        {formatarCustoEquivalente(microUsd)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Custo de hoje</DropdownMenuLabel>
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            Estimativa da CLI a preço de API, não é cobrança da assinatura.
          </p>
        </DropdownMenuGroup>
        {uso.isLoading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Carregando…</p>
        ) : uso.isError || !uso.data ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Não foi possível carregar o detalhe agora.
          </p>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Por modelo</DropdownMenuLabel>
              {uso.data.custo_dia.por_modelo.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">Nenhum uso hoje.</p>
              ) : (
                uso.data.custo_dia.por_modelo.map((m) => (
                  <div key={m.modelo} className="flex items-center gap-2 px-2 py-1 text-sm">
                    <span className="flex-1 truncate font-mono text-xs">{m.modelo}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatarCustoEquivalente(m.micro_usd)}
                    </span>
                  </div>
                ))
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Por execução</DropdownMenuLabel>
              {uso.data.por_execucao.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">Nenhuma execução hoje.</p>
              ) : (
                uso.data.por_execucao.map((e) => (
                  <DropdownMenuItem
                    key={e.execucao_id}
                    render={<Link to={`/execucoes/${e.execucao_id}`} />}
                  >
                    <span className="flex-1 font-medium tabular-nums">#{e.numero}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatarCustoEquivalente(e.micro_usd)}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Cabecalho({
  shell,
  estadoStream,
}: {
  shell: ShellDto | null;
  estadoStream: EstadoConexaoSse;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SeletorProjeto projetos={shell?.projetos ?? []} />
      <div className="flex flex-1 items-center gap-4">
        <TermometroCota cota={shell?.cota ?? null} />
        <CustoDia microUsd={shell?.custo_dia.micro_usd ?? 0} />
      </div>
      <AguardandoVoce pendencias={shell?.aguardando_voce ?? []} />
      <div className="flex items-center">
        <SeletorTema />
        <IndicadorStream estado={estadoStream} />
      </div>
    </header>
  );
}
