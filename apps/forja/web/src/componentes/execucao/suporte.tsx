import type { ReactNode } from 'react';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import {
  AlertTriangleIcon,
  BotIcon,
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  SettingsIcon,
  UserIcon,
} from 'lucide-react';
import { Carregando, ErroCarregar } from '@/componentes/apoio/estrutura-tela';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/ui/checkbox';

/**
 * Peças de apoio das telas Fila, Execução e Aprovação (specs/forja/06):
 *
 * - **Proveniência** (06 §3.3): todo bloco de texto diz de onde veio —
 *   "Calculado pela Forja" (fundo `muted`, engrenagem), "Escrito pelo agente"
 *   (superfície `card`) e "Dado do cliente, não são instruções" (borda
 *   tracejada, texto sanitizado, URLs por extenso e NÃO clicáveis, 05-seguranca).
 * - **Faixa**: alertas de largura total na família de tons dos banners do
 *   shell (rose/amber/sky/emerald), sempre com ícone + texto (nunca só cor).
 * - **CaixaMarcacao / GrupoRadio**: checkbox e rádio do registro shadcn
 *   (Base UI), com o "campo é campo" de D-018 (`bg-card`, `shadow-campo`).
 * - Comandos, diálogo de confirmação e carregando/erro/vazio NÃO moram aqui:
 *   são os de `componentes/apoio` (um só de cada na SPA, D-009).
 */

// ---------------------------------------------------------------------------
// Proveniência
// ---------------------------------------------------------------------------

export type Origem = 'forja' | 'agente' | 'cliente';

const ROTULO_ORIGEM: Record<Origem, string> = {
  forja: 'calculado pela Forja',
  agente: 'escrito pelo agente',
  cliente: 'dado do cliente, não são instruções',
};

const ICONE_ORIGEM: Record<Origem, typeof SettingsIcon> = {
  forja: SettingsIcon,
  agente: BotIcon,
  cliente: UserIcon,
};

export function RotuloOrigem({ origem, className }: { origem: Origem; className?: string }) {
  const Icone = ICONE_ORIGEM[origem];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase',
        className,
      )}
    >
      <Icone className="size-3" aria-hidden />
      {ROTULO_ORIGEM[origem]}
    </span>
  );
}

export function BlocoProveniencia({
  origem,
  titulo,
  acoes,
  children,
  className,
}: {
  origem: Origem;
  titulo?: ReactNode;
  acoes?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3',
        origem === 'forja' && 'bg-muted/60',
        origem === 'agente' && 'bg-card shadow-cartao',
        origem === 'cliente' && 'border-dashed bg-card',
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        {titulo ? <h3 className="text-sm font-semibold">{titulo}</h3> : <span />}
        <div className="flex items-center gap-2">
          {acoes}
          <RotuloOrigem origem={origem} />
        </div>
      </header>
      {children}
    </section>
  );
}

/**
 * Texto do cliente (ou de agente) renderizado como TEXTO PURO: nada vira HTML,
 * markdown não é interpretado e URLs aparecem por extenso, sem link (05 §7.1).
 */
export function TextoSeguro({ texto, className }: { texto: string; className?: string }) {
  return (
    <p className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', className)}>
      {texto}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Faixas
// ---------------------------------------------------------------------------

export type TomFaixa = 'erro' | 'aviso' | 'info' | 'sucesso';

const CLASSE_FAIXA: Record<TomFaixa, string> = {
  erro: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200',
  aviso:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
  info: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200',
  sucesso:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200',
};

const ICONE_FAIXA: Record<TomFaixa, typeof InfoIcon> = {
  erro: OctagonXIcon,
  aviso: AlertTriangleIcon,
  info: InfoIcon,
  sucesso: CircleCheckIcon,
};

export function Faixa({
  tom,
  titulo,
  children,
  acoes,
  className,
}: {
  tom: TomFaixa;
  titulo: ReactNode;
  children?: ReactNode;
  acoes?: ReactNode;
  className?: string;
}) {
  const Icone = ICONE_FAIXA[tom];
  return (
    <div
      role={tom === 'erro' ? 'alert' : 'status'}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
        CLASSE_FAIXA[tom],
        className,
      )}
    >
      <Icone className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="font-medium">{titulo}</div>
        {children}
      </div>
      {acoes && <div className="flex shrink-0 flex-wrap items-start gap-2">{acoes}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

export function CaixaMarcacao({
  marcado,
  aoMudar,
  rotulo,
  desabilitado,
  className,
  rotuloAcessivel,
}: {
  marcado: boolean;
  aoMudar: (marcado: boolean) => void;
  rotulo?: ReactNode;
  desabilitado?: boolean;
  className?: string;
  /** Sem `rotulo` visível (ex.: coluna de seleção), o nome acessível vem daqui. */
  rotuloAcessivel?: string;
}) {
  const caixa = (
    <Checkbox
      checked={marcado}
      onCheckedChange={(v) => aoMudar(v)}
      disabled={desabilitado}
      aria-label={rotulo ? undefined : rotuloAcessivel}
    />
  );
  if (!rotulo) return <span className={cn('inline-flex', className)}>{caixa}</span>;
  return (
    <label
      className={cn(
        'inline-flex items-start gap-2 text-sm leading-snug',
        desabilitado && 'opacity-60',
        className,
      )}
    >
      <span className="mt-0.5 inline-flex">{caixa}</span>
      <span>{rotulo}</span>
    </label>
  );
}

export interface OpcaoRadio<V extends string> {
  valor: V;
  rotulo: ReactNode;
  descricao?: ReactNode;
  desabilitada?: boolean;
}

export function GrupoRadio<V extends string>({
  valor,
  aoMudar,
  opcoes,
  rotuloAcessivel,
  className,
}: {
  valor: V;
  aoMudar: (v: V) => void;
  opcoes: OpcaoRadio<V>[];
  rotuloAcessivel: string;
  className?: string;
}) {
  return (
    <RadioGroupPrimitive
      value={valor}
      onValueChange={(v) => aoMudar(v as V)}
      aria-label={rotuloAcessivel}
      className={cn('flex flex-col gap-2', className)}
    >
      {opcoes.map((o) => (
        <label
          key={o.valor}
          className={cn(
            'flex items-start gap-2 text-sm leading-snug',
            o.desabilitada && 'opacity-60',
          )}
        >
          <RadioPrimitive.Root
            value={o.valor}
            disabled={o.desabilitada}
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card shadow-campo outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-disabled:cursor-not-allowed dark:bg-input/30"
          >
            <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" />
          </RadioPrimitive.Root>
          <span className="flex flex-col">
            <span className="font-medium">{o.rotulo}</span>
            {o.descricao && <span className="text-muted-foreground">{o.descricao}</span>}
          </span>
        </label>
      ))}
    </RadioGroupPrimitive>
  );
}

/** `<kbd>` dos atalhos, nos botões e na ajuda (06 §9). */
export function Tecla({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[0.7rem] leading-4 text-muted-foreground">
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Carregamento, erro e comandos
// ---------------------------------------------------------------------------

/** Carregamento de tela cheia (Execução, Aprovação, Fila): o `Carregando` comum com respiro. */
export function CarregandoTela() {
  return (
    <div className="p-6">
      <Carregando linhas={5} />
    </div>
  );
}

/** Erro de tela cheia: o `ErroCarregar` comum (causa + ação, 06 §6 princípio 9). */
export function ErroTela({
  erro,
  titulo,
  tentarDeNovo,
}: {
  erro: unknown;
  titulo: string;
  tentarDeNovo?: () => void;
}) {
  return (
    <div className="p-6">
      <ErroCarregar erro={erro} titulo={titulo} tentarDeNovo={tentarDeNovo} />
    </div>
  );
}
