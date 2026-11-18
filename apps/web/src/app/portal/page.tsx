import Link from 'next/link';
import { In } from 'typeorm';
import { Download, Inbox, Plus, Search, UserRound, X } from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  listarChamados,
  UsuarioSchema,
  type ChamadoView,
} from '@chamados/db';
import { StatusChamado } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { ROTULO_STATUS_CHAMADO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  StatusBadge,
  NaturezaBadge,
  PrioridadeBadge,
  EstimativaCustoBadge,
  CustoFinalBadge,
} from '@/components/portal/chamado-badges';
import { tempoRelativo, dataHoraAbsoluta } from '@/components/portal/tempo';
import {
  lerListaPortal,
  hrefPortal as href,
  hrefExportacaoPortal,
  statusConsultadosPortal,
  type AbaPortal as Aba,
  type RecortePortal as Recorte,
} from '@/lib/portal-lista';

/**
 * Recorte por solicitante (D-037): o cliente LÊ todos os chamados do tenant, mas
 * a tela abre nos dele ("meus"). "todos" mostra também os dos colegas — sempre
 * na visão pública e, nos alheios, em modo somente leitura. Parse/URL do recorte
 * vivem em `lib/portal-lista.ts` (compartilhado com a exportação Excel — D-045).
 */
const LIMITE = 25;

export default async function PortalHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const estado = lerListaPortal(await searchParams);
  const { ver, aba, grupo, statusFiltro, cursor, busca } = estado;

  const { usuario, tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();
  const { pagina, nomes } = await runInTenantContext(ds, tenant.id, async (em) => {
    const pagina = await listarChamados(em, usuario, {
      meus: ver === 'meus',
      status: statusConsultadosPortal(estado),
      busca: busca || undefined,
      cursor,
      limite: LIMITE,
    });
    // Nome do solicitante só importa no recorte "todos" (nos "meus" é sempre você).
    const nomes = new Map<string, string>();
    if (ver === 'todos') {
      const ids = Array.from(new Set(pagina.itens.map((c) => c.cliente_id)));
      if (ids.length > 0) {
        const us = await em.find(UsuarioSchema, {
          where: { id: In(ids) },
          select: { id: true, nome: true },
        });
        for (const u of us) nomes.set(u.id, u.nome);
      }
    }
    return { pagina, nomes };
  });

  const semNenhum = pagina.itens.length === 0 && !statusFiltro && !cursor && !busca;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {ver === 'todos' ? 'Todos os chamados' : 'Meus chamados'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {ver === 'todos'
              ? `Chamados abertos por todos os usuários de ${tenant.nome_exibicao}.`
              : `Acompanhe seus atendimentos com ${tenant.nome_exibicao}.`}
          </p>
        </div>
        {/* Recorte por solicitante (D-037) */}
        <div
          className="flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
          role="group"
          aria-label="Quais chamados exibir"
        >
          <SegmentoLink
            rotulo="Meus chamados"
            destino={href({ ver: 'meus', aba })}
            ativo={ver === 'meus'}
          />
          <SegmentoLink
            rotulo="Todos os chamados"
            destino={href({ ver: 'todos', aba })}
            ativo={ver === 'todos'}
          />
        </div>
      </div>

      {/* Busca (respeita o recorte) */}
      <form action="/portal" method="get" role="search" className="relative">
        {ver === 'todos' && <input type="hidden" name="ver" value="todos" />}
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          name="q"
          defaultValue={busca}
          placeholder="Buscar por número, título ou descrição…"
          aria-label="Buscar chamados"
          className="pl-9"
        />
      </form>

      {/* Recorte atual (busca OU abas) + exportar o MESMO recorte (D-045) */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {busca ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                Resultados para <span className="font-medium text-foreground">“{busca}”</span>
              </span>
              <Link
                href={href({ ver })}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-7 px-2')}
              >
                <X className="size-3.5" />
                Limpar busca
              </Link>
            </div>
          ) : (
            /* Segmentos abertos/histórico */
            <div className="flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
              <SegmentoLink
                rotulo="Abertos"
                destino={href({ ver, aba: 'abertos' })}
                ativo={aba === 'abertos'}
              />
              <SegmentoLink
                rotulo="Histórico"
                destino={href({ ver, aba: 'historico' })}
                ativo={aba === 'historico'}
              />
            </div>
          )}
          {pagina.itens.length > 0 && (
            <a
              href={hrefExportacaoPortal(estado)}
              download
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              title="Baixa uma planilha .xlsx com todos os chamados desta lista"
            >
              <Download className="size-3.5" aria-hidden />
              Exportar Excel
            </a>
          )}
        </div>

        {/* Filtro simples por status dentro do segmento */}
        {!busca && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ChipStatus rotulo="Todos" ativo={!statusFiltro} destino={href({ ver, aba })} />
            {grupo.map((s) => (
              <ChipStatus
                key={s}
                rotulo={ROTULO_STATUS_CHAMADO[s]}
                ativo={statusFiltro === s}
                destino={href({ ver, aba, status: s })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Lista / estados vazios */}
      {pagina.itens.length === 0 ? (
        semNenhum ? (
          <EstadoVazioInicial ver={ver} />
        ) : (
          <EstadoVazioFiltro aba={aba} ver={ver} busca={busca} />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {pagina.itens.map((c) => (
            <li key={c.id}>
              <ChamadoCard
                chamado={c}
                meu={c.cliente_id === usuario.id}
                solicitante={ver === 'todos' ? (nomes.get(c.cliente_id) ?? null) : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      {pagina.proximoCursor && (
        <div className="flex justify-center">
          <Link
            href={href({
              ver,
              aba,
              status: statusFiltro,
              q: busca || undefined,
              cursor: pagina.proximoCursor,
            })}
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

function SegmentoLink({
  rotulo,
  destino,
  ativo,
}: {
  rotulo: string;
  destino: string;
  ativo: boolean;
}) {
  return (
    <Link
      href={destino}
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

function ChamadoCard({
  chamado,
  meu,
  solicitante,
}: {
  chamado: ChamadoView;
  /** O usuário é o solicitante? ("Aguardando você" só faz sentido nos dele.) */
  meu: boolean;
  /** Nome do solicitante — informado só no recorte "todos". */
  solicitante?: string | null;
}) {
  const aguardando = meu && chamado.status === StatusChamado.aguardando_cliente;
  // D-042: resolvido do próprio cliente = janela de aprovação aberta (discreto).
  const aguardandoAprovacao = meu && chamado.status === StatusChamado.resolvido;
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
          {solicitante !== undefined && (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <UserRound className="size-3.5 shrink-0" aria-hidden />
              {meu ? 'Você' : (solicitante ?? 'Solicitante')}
            </p>
          )}
        </div>
        {aguardando && (
          <span className="shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
            Aguardando você
          </span>
        )}
        {aguardandoAprovacao && (
          <span className="shrink-0 rounded-full border border-emerald-500/40 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Aguardando sua aprovação
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={chamado.status} />
        <PrioridadeBadge prioridade={chamado.prioridade} />
        <NaturezaBadge natureza={chamado.natureza} />
        {/* D-043: estimativa e custo final (públicos). */}
        {chamado.estimativa_custo && <EstimativaCustoBadge estimativa={chamado.estimativa_custo} />}
        {chamado.custo_final != null && <CustoFinalBadge valor={chamado.custo_final} />}
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

function EstadoVazioInicial({ ver }: { ver: Recorte }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold">
          {ver === 'todos' ? 'Nenhum chamado por aqui ainda' : 'Você ainda não abriu chamados'}
        </h2>
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

function EstadoVazioFiltro({ aba, ver, busca }: { aba: Aba; ver: Recorte; busca: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </span>
      <p className="text-sm text-muted-foreground">
        {busca
          ? 'Nenhum chamado encontrado para essa busca.'
          : aba === 'historico'
            ? 'Nenhum chamado encerrado por aqui ainda.'
            : 'Nenhum chamado aberto com esse filtro.'}
      </p>
      <Link
        href={href({ ver, aba })}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      >
        {busca ? 'Limpar busca' : 'Limpar filtro'}
      </Link>
    </div>
  );
}
