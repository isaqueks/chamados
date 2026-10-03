import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangleIcon, ArrowLeftIcon, CogIcon, RotateCwIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import { mensagemErro } from './texto';

/**
 * Esqueleto comum das telas de apoio (specs/forja/06 §4.4–§4.11): título com a
 * pergunta que a tela responde (06 §2), ações à direita (uma primária por tela,
 * §6 item 8) e os três estados que toda tela precisa — carregando, erro com a
 * causa e a ação, e vazio que ensina o próximo passo (§6 item 9).
 *
 * POR QUE componentes próprios em vez de repetir o markup: D-009 exige
 * consistência; o mesmo cabeçalho/vazio/erro em onze telas é o jeito barato de
 * garantir isso sem estilo ad-hoc.
 */

export function Pagina({
  children,
  largura = 'normal',
}: {
  children: ReactNode;
  largura?: 'normal' | 'larga' | 'cheia';
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-6 p-6',
        largura === 'normal' && 'max-w-5xl',
        largura === 'larga' && 'max-w-7xl',
      )}
    >
      {children}
    </div>
  );
}

export function CabecalhoPagina({
  titulo,
  descricao,
  acoes,
  voltar,
  extra,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  voltar?: { href: string; rotulo: string };
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {voltar && (
        <Link
          to={voltar.href}
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3" aria-hidden />
          {voltar.rotulo}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{titulo}</h1>
          {descricao && <p className="text-sm text-muted-foreground">{descricao}</p>}
        </div>
        {acoes && <div className="flex flex-wrap items-center gap-2">{acoes}</div>}
      </div>
      {extra}
    </div>
  );
}

export function Carregando({ linhas = 4 }: { linhas?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: linhas }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ErroCarregar({
  erro,
  tentarDeNovo,
  titulo = 'Não foi possível carregar',
}: {
  erro: unknown;
  tentarDeNovo?: () => void;
  titulo?: string;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>{titulo}</AlertTitle>
      <AlertDescription>
        <p>{mensagemErro(erro)}</p>
        {tentarDeNovo && (
          <Button variant="outline" size="sm" onClick={tentarDeNovo} className="mt-1">
            <RotateCwIcon aria-hidden />
            Tentar de novo
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function Vazio({
  icone: Icone,
  titulo,
  descricao,
  acao,
}: {
  icone: typeof CogIcon;
  titulo: string;
  descricao?: ReactNode;
  acao?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted">
          <Icone className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p className="font-medium">{titulo}</p>
          {descricao && <p className="max-w-md text-sm text-muted-foreground">{descricao}</p>}
        </div>
        {acao}
      </CardContent>
    </Card>
  );
}

/** Seção com título pequeno em caixa alta, como as faixas dos wireframes de 06 §4.6. */
export function Secao({
  titulo,
  acoes,
  children,
  id,
  descricao,
}: {
  titulo: ReactNode;
  acoes?: ReactNode;
  children: ReactNode;
  id?: string;
  descricao?: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {titulo}
          </h2>
          {descricao && <p className="text-sm text-muted-foreground">{descricao}</p>}
        </div>
        {acoes && <div className="flex items-center gap-2">{acoes}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Rótulo de proveniência "Calculado pela Forja" (06 §3.3): fundo `muted` e
 * engrenagem — distingue o que o app mediu do que o agente escreveu.
 */
export function RotuloCalculado({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <CogIcon className="size-3" aria-hidden />
      calculado pela Forja
    </span>
  );
}

/** Faixa de largura total (alerta de tela): `erro` rose, `aviso` âmbar, `info` neutra. */
export function Faixa({
  nivel,
  icone: Icone = AlertTriangleIcon,
  children,
  acoes,
}: {
  nivel: 'erro' | 'aviso' | 'info';
  icone?: typeof AlertTriangleIcon;
  children: ReactNode;
  acoes?: ReactNode;
}) {
  return (
    <div
      role={nivel === 'erro' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5 text-sm',
        nivel === 'erro' &&
          'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200',
        nivel === 'aviso' &&
          'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
        nivel === 'info' && 'border-border bg-muted/50 text-foreground',
      )}
    >
      <Icone className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {acoes && <div className="flex flex-wrap items-center gap-2">{acoes}</div>}
    </div>
  );
}
