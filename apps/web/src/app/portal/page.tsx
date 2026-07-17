import Link from 'next/link';
import { Inbox, Plus } from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  listarChamados,
  type ChamadoView,
} from '@chamados/db';
import { StatusChamado } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { ROTULO_STATUS_CHAMADO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { StatusBadge, NaturezaBadge, PrioridadeBadge } from '@/components/portal/chamado-badges';
import { tempoRelativo, dataHoraAbsoluta } from '@/components/portal/tempo';

type Aba = 'abertos' | 'historico';

const ABERTOS: StatusChamado[] = [
  StatusChamado.novo,
  StatusChamado.em_triagem,
  StatusChamado.aguardando_cliente,
  StatusChamado.em_atendimento,
];
const HISTORICO: StatusChamado[] = [
  StatusChamado.resolvido,
  StatusChamado.fechado,
  StatusChamado.cancelado,
];

const LIMITE = 25;

interface Busca {
  aba?: string;
  status?: string;
  cursor?: string;
}

function ehStatus(v: string | undefined): v is StatusChamado {
  return !!v && (Object.values(StatusChamado) as string[]).includes(v);
}

/** Monta um href de /portal preservando só os parâmetros informados. */
function href(params: { aba?: Aba; status?: StatusChamado; cursor?: string }): string {
  const sp = new URLSearchParams();
  if (params.aba && params.aba !== 'abertos') sp.set('aba', params.aba);
  if (params.status) sp.set('status', params.status);
  if (params.cursor) sp.set('cursor', params.cursor);
  const qs = sp.toString();
  return qs ? `/portal?${qs}` : '/portal';
}

export default async function PortalHomePage({ searchParams }: { searchParams: Promise<Busca> }) {
  const sp = await searchParams;
  const aba: Aba = sp.aba === 'historico' ? 'historico' : 'abertos';
  const grupo = aba === 'historico' ? HISTORICO : ABERTOS;
  const statusFiltro = ehStatus(sp.status) && grupo.includes(sp.status) ? sp.status : undefined;
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;

  const { usuario, tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();
  const pagina = await runInTenantContext(ds, tenant.id, (em) =>
    listarChamados(em, usuario, {
      status: statusFiltro ? [statusFiltro] : grupo,
      cursor,
      limite: LIMITE,
    }),
  );

  const semNenhum = pagina.itens.length === 0 && !statusFiltro && !cursor;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Meus chamados</h1>
        <p className="text-sm text-muted-foreground">
          Acompanhe seus atendimentos com {tenant.nome_exibicao}.
        </p>
      </div>

      {/* Segmentos abertos/histórico */}
      <div className="flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
        <SegmentoLink rotulo="Abertos" alvo="abertos" atual={aba} />
        <SegmentoLink rotulo="Histórico" alvo="historico" atual={aba} />
      </div>

      {/* Filtro simples por status dentro do segmento */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ChipStatus rotulo="Todos" ativo={!statusFiltro} destino={href({ aba })} />
        {grupo.map((s) => (
          <ChipStatus
            key={s}
            rotulo={ROTULO_STATUS_CHAMADO[s]}
            ativo={statusFiltro === s}
            destino={href({ aba, status: s })}
          />
        ))}
      </div>

      {/* Lista / estados vazios */}
      {pagina.itens.length === 0 ? (
        semNenhum ? (
          <EstadoVazioInicial />
        ) : (
          <EstadoVazioFiltro aba={aba} />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {pagina.itens.map((c) => (
            <li key={c.id}>
              <ChamadoCard chamado={c} />
            </li>
          ))}
        </ul>
      )}

      {pagina.proximoCursor && (
        <div className="flex justify-center">
          <Link
            href={href({ aba, status: statusFiltro, cursor: pagina.proximoCursor })}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            Carregar mais
          </Link>
        </div>
      )}

      {/* FAB no mobile (specs/08 §3) */}
      <Link
        href="/portal/novo"
        className={cn(
          buttonVariants({ size: 'lg' }),
          'fixed right-4 bottom-4 z-30 shadow-lg sm:hidden',
        )}
        aria-label="Abrir chamado"
      >
        <Plus />
        Abrir chamado
      </Link>
    </div>
  );
}

function SegmentoLink({ rotulo, alvo, atual }: { rotulo: string; alvo: Aba; atual: Aba }) {
  const ativo = atual === alvo;
  return (
    <Link
      href={href({ aba: alvo })}
      className={cn(
        'rounded-md px-3 py-1 text-sm font-medium transition-colors',
        ativo
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
      aria-current={ativo ? 'page' : undefined}
    >
      {rotulo}
    </Link>
  );
}

function ChipStatus({
  rotulo,
  ativo,
  destino,
}: {
  rotulo: string;
  ativo: boolean;
  destino: string;
}) {
  return (
    <Link
      href={destino}
      aria-pressed={ativo}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        ativo
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {rotulo}
    </Link>
  );
}

function ChamadoCard({ chamado }: { chamado: ChamadoView }) {
  const aguardando = chamado.status === StatusChamado.aguardando_cliente;
  return (
    <Link
      href={`/portal/chamados/${chamado.id}`}
      className="block rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Número integrado à linha do título (nunca órfão). */}
          <h3 className="truncate font-medium">
            <span className="mr-1.5 text-sm font-normal text-muted-foreground">
              #{String(chamado.numero)}
            </span>
            {chamado.titulo}
          </h3>
        </div>
        {aguardando && (
          <span className="shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
            Aguardando você
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={chamado.status} />
        <PrioridadeBadge prioridade={chamado.prioridade} />
        <NaturezaBadge natureza={chamado.natureza} />
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={dataHoraAbsoluta(chamado.updated_at)}
        >
          Atualizado {tempoRelativo(chamado.updated_at)}
        </span>
      </div>
    </Link>
  );
}

function EstadoVazioInicial() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold">Você ainda não abriu chamados</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Precisa de ajuda ou quer solicitar uma mudança? Abra seu primeiro chamado — é rápido.
        </p>
      </div>
      <Link href="/portal/novo" className={cn(buttonVariants({ size: 'lg' }))}>
        <Plus />
        Abrir chamado
      </Link>
    </div>
  );
}

function EstadoVazioFiltro({ aba }: { aba: Aba }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </span>
      <p className="text-sm text-muted-foreground">
        {aba === 'historico'
          ? 'Nenhum chamado encerrado por aqui ainda.'
          : 'Nenhum chamado aberto com esse filtro.'}
      </p>
      <Link href={href({ aba })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
        Limpar filtro
      </Link>
    </div>
  );
}
