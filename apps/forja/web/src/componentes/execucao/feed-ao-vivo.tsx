import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BanIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SettingsIcon,
  TriangleIcon,
} from 'lucide-react';
import type { EtapaDto } from '@comum/dto';
import type { EventoForja } from '@comum/protocolo-eventos';
import { api } from '@/lib/api';
import { ROTULO_ETAPA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Skeleton } from '@/ui/skeleton';
import {
  arvoreDoFeed,
  textoDaLinha,
  tomDaLinha,
  ultimoMarco,
  type ModoFeed,
  type NoFeed,
  type TomLinhaFeed,
} from './arvore-feed';
import { autorPrincipal, horaFeed, nomeModelo } from './formato-execucao';
import { RotuloOrigem } from './suporte';
import { Segmentado } from '@/ui/segmentado';

/**
 * Feed ao vivo da Execução (specs/forja/06 §4.2 "Feed"): eventos ⚙ do app
 * (etapa, commit, verificação com exit code, estado, cota) intercalados com o
 * stream da CLI (falas, `tool_use`/`tool_result` resumidos), em árvore
 * Fable → Opus por `parent_tool_use_id` (lógica pura em `arvore-feed.ts`).
 *
 * - Padrão "Marcos"; "Tudo" mostra também texto e leituras. Os nós de despacho
 *   recolhem.
 * - Negações de permissão: linha rose "NEGADO <ferramenta>(<resumo>) · regra
 *   deny da Forja"; "Fable editou diretamente": linha âmbar ▲ (informativa).
 * - Acessibilidade (06 §9): o feed visual é `role="log"` SEM `aria-live`; uma
 *   região `aria-live="polite"` separada anuncia só o último MARCO, para o
 *   leitor de tela não ser inundado.
 * - "Transcript bruto": o `eventos.jsonl` da etapa paginado, sem parse
 *   "inteligente" (o formato do transcript da CLI é interno [V 01 §3]).
 */

const CLASSE_TOM: Record<TomLinhaFeed, string> = {
  normal: '',
  app: 'text-muted-foreground',
  negacao:
    'rounded bg-rose-50 px-1 font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  fora_do_papel: 'rounded bg-amber-50 px-1 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  erro: 'text-rose-700 dark:text-rose-300',
  aviso: 'text-amber-700 dark:text-amber-300',
};

function IconeLinha({ tom }: { tom: TomLinhaFeed }) {
  if (tom === 'app') return <SettingsIcon className="mt-0.5 size-3 shrink-0" aria-label="Forja" />;
  if (tom === 'negacao') return <BanIcon className="mt-0.5 size-3 shrink-0" aria-label="negado" />;
  if (tom === 'fora_do_papel') {
    return <TriangleIcon className="mt-0.5 size-3 shrink-0 fill-current" aria-label="atenção" />;
  }
  return <span className="w-3 shrink-0" aria-hidden />;
}

function autorDoEvento(e: EventoForja, dentroDeSubagente: string | null): string | null {
  if ('papel_agente' in e.dados) {
    return dentroDeSubagente ?? autorPrincipal(e.dados.papel_agente);
  }
  return null;
}

function LinhaEvento({
  evento,
  resultado,
  subagente,
}: {
  evento: EventoForja;
  resultado: NoFeed['resultado'];
  subagente: string | null;
}) {
  const tom = tomDaLinha(evento);
  const autor = autorDoEvento(evento, subagente);
  const texto = evento.tipo === 'agente.texto' ? evento.dados.texto : textoDaLinha(evento);
  return (
    <div className="flex items-start gap-2 py-0.5">
      <time
        className="w-16 shrink-0 font-mono text-[0.7rem] leading-5 text-muted-foreground"
        dateTime={evento.em}
      >
        {horaFeed(evento.em)}
      </time>
      <IconeLinha tom={tom} />
      <div className={cn('min-w-0 flex-1 text-sm leading-5 break-words', CLASSE_TOM[tom])}>
        {autor && <span className="mr-1.5 font-medium text-foreground">{autor}</span>}
        <span className={cn(evento.tipo === 'agente.texto' && 'whitespace-pre-wrap')}>{texto}</span>
        {resultado && (
          <span
            className={cn(
              'ml-1.5 text-xs',
              resultado.dados.erro ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground',
            )}
          >
            · {resultado.dados.resumo}
          </span>
        )}
      </div>
    </div>
  );
}

function NoDoFeed({ no, subagentePai }: { no: NoFeed; subagentePai: string | null }) {
  const [aberto, setAberto] = useState(true);
  if (!no.subagente) {
    return no.evento ? (
      <LinhaEvento evento={no.evento} resultado={no.resultado} subagente={subagentePai} />
    ) : null;
  }
  const s = no.subagente;
  const modelo = nomeModelo(s.modelo);
  const despachante = subagentePai ?? 'Fable';
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 py-0.5">
        <time className="w-16 shrink-0 font-mono text-[0.7rem] leading-5 text-muted-foreground">
          {no.evento ? horaFeed(no.evento.em) : ''}
        </time>
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
          className="mt-0.5 shrink-0 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={aberto ? 'Recolher despacho' : 'Expandir despacho'}
        >
          {aberto ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
        <div className="min-w-0 flex-1 text-sm leading-5">
          {no.orfao ? (
            <span className="text-muted-foreground">
              despacho anterior (fora da janela carregada)
            </span>
          ) : (
            <>
              <span className="font-medium">{despachante}</span>
              <span className="text-muted-foreground"> → </span>
              <span className="font-medium">{s.nome}</span>
              {modelo && <span className="text-muted-foreground"> ({modelo})</span>}
              {s.descricao && <span> “{s.descricao}”</span>}
            </>
          )}
          {s.status && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              · {s.status}
              {s.resumo ? `: ${s.resumo}` : ''}
            </span>
          )}
          {!aberto && (
            <span className="ml-1.5 text-xs text-muted-foreground">({no.filhos.length} itens)</span>
          )}
        </div>
      </div>
      {aberto && no.filhos.length > 0 && (
        <div className="ml-[5.25rem] border-l pl-3">
          {no.filhos.map((f) => (
            <NoDoFeed key={f.chave} no={f} subagentePai={s.nome} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FeedAoVivo({
  eventos,
  carregando,
  haMaisAntigos,
  aoCarregarAnteriores,
  etapas,
  execucaoId,
}: {
  eventos: EventoForja[];
  carregando: boolean;
  haMaisAntigos: boolean;
  aoCarregarAnteriores: () => void;
  etapas: EtapaDto[];
  execucaoId: string;
}) {
  const [modo, setModo] = useState<ModoFeed>('marcos');
  const [transcriptAberto, setTranscriptAberto] = useState(false);
  const arvore = useMemo(() => arvoreDoFeed(eventos, modo), [eventos, modo]);
  const marco = useMemo(() => ultimoMarco(eventos), [eventos]);
  const rolagem = useRef<HTMLDivElement>(null);
  const grudadoNoFim = useRef(true);

  useLayoutEffect(() => {
    const el = rolagem.current;
    if (el && grudadoNoFim.current) el.scrollTop = el.scrollHeight;
  }, [arvore]);

  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-lg border bg-card p-3 shadow-cartao">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Feed</h3>
        <div className="flex items-center gap-2">
          <Segmentado
            rotuloAcessivel="Detalhe do feed"
            valor={modo}
            aoMudar={setModo}
            opcoes={
              [
                ['marcos', 'Marcos'],
                ['tudo', 'Tudo'],
              ] as const
            }
          />
          <Button
            variant="outline"
            size="xs"
            onClick={() => setTranscriptAberto(true)}
            disabled={etapas.length === 0}
          >
            Transcript bruto
          </Button>
        </div>
      </header>

      <div
        ref={rolagem}
        role="log"
        aria-live="off"
        aria-label="Feed da execução"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          grudadoNoFim.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[60vh] min-h-48 overflow-y-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {haMaisAntigos && (
          <div className="pb-2">
            <Button variant="ghost" size="xs" onClick={aoCarregarAnteriores}>
              Carregar anteriores
            </Button>
          </div>
        )}
        {carregando && eventos.length === 0 ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : arvore.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nada por aqui ainda. Os eventos aparecem conforme as etapas rodam.
          </p>
        ) : (
          arvore.map((no) => <NoDoFeed key={no.chave} no={no} subagentePai={null} />)
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {marco ? textoDaLinha(marco) : ''}
      </div>
      <TranscriptBruto
        execucaoId={execucaoId}
        etapas={etapas}
        aberto={transcriptAberto}
        aoFechar={() => setTranscriptAberto(false)}
      />
    </section>
  );
}

function TranscriptBruto({
  execucaoId,
  etapas,
  aberto,
  aoFechar,
}: {
  execucaoId: string;
  etapas: EtapaDto[];
  aberto: boolean;
  aoFechar: () => void;
}) {
  const [etapaId, setEtapaId] = useState<string | null>(null);
  const [pagina, setPagina] = useState(1);
  const ultima = etapas[etapas.length - 1];
  useEffect(() => {
    if (aberto && !etapaId && ultima) setEtapaId(ultima.id);
  }, [aberto, etapaId, ultima]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['transcript', execucaoId, etapaId, pagina],
    queryFn: ({ signal }) =>
      api('execucao_transcript', {
        params: { id: execucaoId, etapa_id: etapaId! },
        entrada: { pagina },
        sinal: signal,
      }),
    enabled: aberto && !!etapaId,
  });

  return (
    <Sheet open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <SheetContent className="w-full overflow-hidden sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Transcript bruto</SheetTitle>
          <SheetDescription>
            <code className="font-mono">eventos.jsonl</code> da etapa, sem interpretação.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <div className="flex flex-wrap gap-1">
            {etapas.map((e) => (
              <Button
                key={e.id}
                size="xs"
                variant={e.id === etapaId ? 'default' : 'outline'}
                onClick={() => {
                  setEtapaId(e.id);
                  setPagina(1);
                }}
              >
                {e.n}. {ROTULO_ETAPA[e.tipo]}
                {e.negacoes > 0 && ` · ${e.negacoes} negadas`}
              </Button>
            ))}
          </div>
          <RotuloOrigem origem="forja" />
          {error ? (
            <p className="text-sm text-muted-foreground">Transcript indisponível.</p>
          ) : isLoading || !data ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <pre className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/60 p-3 font-mono text-[0.7rem] leading-4">
                {data.linhas.join('\n')}
              </pre>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pagina <= 1}
                  onClick={() => setPagina(pagina - 1)}
                >
                  Anterior
                </Button>
                página {data.pagina} de {data.total_paginas}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pagina >= data.total_paginas}
                  onClick={() => setPagina(pagina + 1)}
                >
                  Próxima
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
