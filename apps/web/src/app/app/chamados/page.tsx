import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  BotOff,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileSpreadsheet,
  Hourglass,
  Inbox,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  listarFilaChamados,
  contarFila,
  listarSistemasAlvo,
  listarCategorias,
  listarOperadoresDoTenant,
  listarClientesAtivosDoTenant,
  interpretarBusca,
  OFFSET_MAX_FILA,
  TETO_EXPORTACAO,
  type CampoOrdenacaoFila,
  type FilaChamadoItem,
} from '@chamados/db';
import { StatusChamado, STATUS_ABERTOS, type SituacaoChamado } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { Button, buttonVariants } from '@/components/ui/button';
import { badgeVariants } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  StatusBadge,
  PrioridadeBadge,
  NaturezaBadge,
  ResumoCusto,
  CustoFinalBadge,
  EstimativaCustoBadge,
} from '@/components/chamado/badges';
import { ROTULO_COMPLEXIDADE, ROTULO_NATUREZA, iniciais } from '@/lib/rotulos';
import { dataHora, tempoRelativo } from '@/lib/tempo';
import {
  lerEstadoFila,
  paraFiltrosFila,
  hrefFila,
  hrefExportacaoFila,
  estadoLimpo,
  filtrosAtivos,
  ordemEfetiva,
  ordenacaoDaColuna,
  fraseOrdem,
  faixaDaPagina,
  type EstadoFila,
  type NomesFila,
} from '@/lib/fila-params';
import { cn } from '@/lib/utils';
import { FilaBarra, SeletorPorPagina } from './filtros';
import { BotaoAssumir } from './acoes-linha';
import { LinhaClicavel } from './linha-clicavel';

type ParamsBrutos = Record<string, string | string[] | undefined>;

const fmtNumero = new Intl.NumberFormat('pt-BR');
const fmtDiaMes = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

/** [singular, plural] do recorte no subtítulo ("1 chamado encerrado"). */
const ROTULO_RECORTE: Record<SituacaoChamado, [string, string]> = {
  abertos: ['em aberto', 'em aberto'],
  encerrados: ['encerrado', 'encerrados'],
  todos: ['no total', 'no total'],
};

/**
 * Fila de chamados do painel (specs/08 §4.4, D-045 — evolui D-030). Server
 * component: a URL é o estado (`lib/fila-params`), a consulta roda sob RLS e a
 * tabela é renderizada no servidor; só a barra de filtros é client.
 */
export default async function FilaPage({ searchParams }: { searchParams: Promise<ParamsBrutos> }) {
  const { usuario, tenant } = await exigirUsuario();
  const estado = lerEstadoFila(await searchParams);
  const buscaPorRelevancia = !estado.ordem && interpretarBusca(estado.busca).modo === 'fts';
  const filtros = paraFiltrosFila(estado);

  const ds = await obterAppDataSource();
  const { pagina, contadores, sistemas, categorias, operadores, clientes } =
    await runInTenantContext(ds, tenant.id, async (em) => ({
      pagina: await listarFilaChamados(em, usuario, filtros),
      contadores: await contarFila(em, usuario, filtros),
      sistemas: await listarSistemasAlvo(em),
      categorias: await listarCategorias(em),
      operadores: await listarOperadoresDoTenant(em),
      clientes: await listarClientesAtivosDoTenant(em, usuario),
    }));

  const nomes: NomesFila = {
    operadores: Object.fromEntries(operadores.map((o) => [o.id, o.nome])),
    clientes: Object.fromEntries(clientes.map((c) => [c.id, c.nome])),
    sistemas: Object.fromEntries(sistemas.map((s) => [s.id, s.nome])),
    categorias: Object.fromEntries(categorias.map((c) => [c.id, c.nome])),
  };
  const chips = filtrosAtivos(estado, nomes);
  const temFiltro = chips.length > 0 || Boolean(estado.busca);
  const total = contadores.filtrados;
  const ordem = ordemEfetiva(estado, buscaPorRelevancia);
  // Estado efetivamente servido (a consulta limita a página ao teto de offset).
  const servido: EstadoFila = { ...estado, pagina: pagina.pagina };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      {/* Cabeçalho: título + tamanho do recorte; ações à direita. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Chamados</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {fmtNumero.format(total)}
            </span>{' '}
            {total === 1 ? 'chamado' : 'chamados'}{' '}
            {ROTULO_RECORTE[estado.situacao][total === 1 ? 0 : 1]}
            {temFiltro ? ' com os filtros aplicados' : ''} · ordenados por {fraseOrdem(ordem)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BotaoExportar estado={servido} total={total} />
          {/* D-040: abrir chamado em nome de um cliente. */}
          <Link href="/app/chamados/novo" className={buttonVariants()}>
            <Plus className="size-4" />
            Novo chamado
          </Link>
        </div>
      </div>

      <section
        aria-label="Fila de chamados"
        className="overflow-hidden rounded-xl border bg-card shadow-cartao"
      >
        <FilaBarra
          estado={servido}
          contadores={contadores}
          operadores={operadores.map((o) => ({ id: o.id, nome: o.nome }))}
          clientes={clientes.map((c) => ({ id: c.id, nome: c.nome, email: c.email }))}
          sistemas={sistemas.map((s) => ({ id: s.id, nome: s.nome }))}
          categorias={categorias.map((c) => ({ id: c.id, nome: c.nome }))}
          buscaPorRelevancia={buscaPorRelevancia}
        />

        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-2 sm:px-4">
            <span className="mr-1 text-xs text-muted-foreground">Filtrando por</span>
            <ul className="contents">
              {chips.map((f) => (
                <li key={f.chave}>
                  <Link
                    href={hrefFila(servido, f.remover)}
                    aria-label={`Remover filtro ${f.rotulo}: ${f.valor}`}
                    className={cn(
                      badgeVariants({ variant: 'outline' }),
                      'h-6 gap-1 bg-card font-normal transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                    )}
                  >
                    <span className="text-muted-foreground">{f.rotulo}:</span>
                    <span className="max-w-[14rem] truncate font-medium">{f.valor}</span>
                    <X className="text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href={hrefFila(estadoLimpo(servido, { manterBusca: true }))}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'xs' }),
                'text-muted-foreground',
              )}
            >
              Limpar tudo
            </Link>
          </div>
        )}

        {pagina.itens.length === 0 ? (
          <VazioFila estado={servido} temFiltro={temFiltro} totalRecorte={total} />
        ) : (
          <>
            <TabelaFila
              itens={pagina.itens}
              estado={servido}
              euId={usuario.id}
              buscaPorRelevancia={buscaPorRelevancia}
            />
            <ListaFilaCompacta itens={pagina.itens} euId={usuario.id} />
            <Rodape
              estado={servido}
              total={total}
              itensNaPagina={pagina.itens.length}
              temMais={pagina.temMais}
            />
          </>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------- Exportar

function BotaoExportar({ estado, total }: { estado: EstadoFila; total: number }) {
  if (total === 0) {
    return (
      <Button variant="outline" disabled title="Nada a exportar neste recorte">
        <FileSpreadsheet className="size-4" />
        <span className="hidden sm:inline">Exportar Excel</span>
        <span className="sm:hidden">Excel</span>
      </Button>
    );
  }
  const parcial = total > TETO_EXPORTACAO;
  const titulo = parcial
    ? `Baixa .xlsx com os primeiros ${fmtNumero.format(TETO_EXPORTACAO)} de ${fmtNumero.format(total)} chamados deste recorte (teto da exportação)`
    : `Baixa .xlsx com ${total === 1 ? 'o chamado' : `os ${fmtNumero.format(total)} chamados`} deste recorte`;
  return (
    // Download de arquivo: <a> simples (não é navegação do App Router).
    <a
      href={hrefExportacaoFila(estado)}
      download
      title={titulo}
      className={buttonVariants({ variant: 'outline' })}
    >
      <FileSpreadsheet className="size-4" aria-hidden />
      <span className="hidden sm:inline">Exportar Excel</span>
      <span className="sm:hidden">Excel</span>
    </a>
  );
}

// -------------------------------------------------------------- Tabela (≥ lg)

function CabecalhoOrdenavel({
  campo,
  rotulo,
  rotuloOrdenacao,
  estado,
  buscaPorRelevancia,
  className,
}: {
  campo: CampoOrdenacaoFila;
  rotulo: string;
  /** Como o leitor de tela ouve o critério ("número", "prioridade"…). */
  rotuloOrdenacao: string;
  estado: EstadoFila;
  buscaPorRelevancia: boolean;
  className?: string;
}) {
  const { direcao, href } = ordenacaoDaColuna(estado, campo, buscaPorRelevancia);
  const Icone = direcao === 'asc' ? ArrowUp : direcao === 'desc' ? ArrowDown : ChevronsUpDown;
  const proxima = direcao === 'desc' ? 'crescente' : 'decrescente';
  return (
    <TableHead
      aria-sort={direcao === 'asc' ? 'ascending' : direcao === 'desc' ? 'descending' : 'none'}
      className={className}
    >
      <Link
        href={href}
        className={cn(
          '-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 uppercase outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          direcao && 'text-foreground',
        )}
      >
        {rotulo}
        <Icone className={cn('size-3.5', !direcao && 'opacity-50')} aria-hidden />
        <span className="sr-only">
          {' '}
          — ordenar por {rotuloOrdenacao}, {proxima}
        </span>
      </Link>
    </TableHead>
  );
}

function TabelaFila({
  itens,
  estado,
  euId,
  buscaPorRelevancia,
}: {
  itens: FilaChamadoItem[];
  estado: EstadoFila;
  euId: string;
  buscaPorRelevancia: boolean;
}) {
  return (
    // ≥ 1280 px. Abaixo disso (conteúdo ≤ ~990 px ao lado da sidebar) a coluna do
    // título ficaria estreita demais: a fila vira lista (ListaFilaCompacta).
    <Table className="hidden table-fixed xl:table">
      <TableHeader>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <CabecalhoOrdenavel
            campo="numero"
            rotulo="Chamado"
            rotuloOrdenacao="número"
            estado={estado}
            buscaPorRelevancia={buscaPorRelevancia}
            className="pl-4"
          />
          {/* table-fixed: larguras vêm do cabeçalho; a coluna "Chamado" fica com o resto. */}
          <TableHead className="w-40">Status</TableHead>
          <CabecalhoOrdenavel
            campo="prioridade"
            rotulo="Prioridade"
            rotuloOrdenacao="prioridade"
            estado={estado}
            buscaPorRelevancia={buscaPorRelevancia}
            className="w-24"
          />
          <TableHead className="w-48">Responsável</TableHead>
          <TableHead className="hidden w-32 2xl:table-cell">Natureza</TableHead>
          <TableHead className="w-32">Custo</TableHead>
          <CabecalhoOrdenavel
            campo="atualizado"
            rotulo="Atualizado"
            rotuloOrdenacao="última atualização"
            estado={estado}
            buscaPorRelevancia={buscaPorRelevancia}
            className="w-24 pr-4 text-right"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((c) => (
          // Linha inteira clicável com UM link acessível (o título) — ver LinhaClicavel.
          <LinhaClicavel
            key={c.id}
            href={`/app/chamados/${c.id}`}
            className="group/linha has-[a[data-titulo]:focus-visible]:bg-muted/60"
          >
            <TableCell className="py-2.5 pl-4 whitespace-normal">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    #{c.numero}
                  </span>
                  <Link
                    href={`/app/chamados/${c.id}`}
                    title={c.titulo}
                    data-titulo
                    className="min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {c.titulo}
                  </Link>
                  <Indicadores chamado={c} />
                </div>
                <LinhaSecundaria chamado={c} naturezaAte2xl />
              </div>
            </TableCell>
            <TableCell>
              <StatusBadge status={c.status} />
            </TableCell>
            <TableCell>
              <PrioridadeBadge prioridade={c.prioridade} />
            </TableCell>
            <TableCell>
              <Responsavel chamado={c} euId={euId} />
            </TableCell>
            <TableCell className="hidden 2xl:table-cell">
              <div className="flex flex-col items-start gap-0.5">
                <NaturezaBadge natureza={c.natureza} />
                <span className="text-xs text-muted-foreground" title="Complexidade (interna)">
                  {c.complexidade ? ROTULO_COMPLEXIDADE[c.complexidade] : 'Sem complexidade'}
                </span>
              </div>
            </TableCell>
            <TableCell>
              <ResumoCusto estimativa={c.estimativa_custo} custoFinal={c.custo_final} />
            </TableCell>
            <TableCell className="pr-4 text-right text-sm text-muted-foreground">
              <time dateTime={new Date(c.updated_at).toISOString()} title={dataHora(c.updated_at)}>
                {tempoRelativo(c.updated_at)}
              </time>
            </TableCell>
          </LinhaClicavel>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * "Solicitante · Alvo" (+ janela de aprovação quando resolvido — D-042). Na
 * tabela, enquanto a coluna Natureza está oculta (< 1536 px), a natureza vem aqui.
 */
function LinhaSecundaria({
  chamado: c,
  naturezaAte2xl = false,
}: {
  chamado: FilaChamadoItem;
  naturezaAte2xl?: boolean;
}) {
  const alvo = c.sistema_nome ?? c.categoria_nome;
  const aprovacao =
    c.status === StatusChamado.resolvido && c.fechar_automaticamente_em
      ? fmtDiaMes.format(new Date(c.fechar_automaticamente_em))
      : null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">
        {c.solicitante_nome ?? 'Solicitante removido'}
        {alvo ? ` · ${alvo}` : ''}
        {naturezaAte2xl && <span className="2xl:hidden"> · {ROTULO_NATUREZA[c.natureza]}</span>}
      </span>
      {aprovacao && (
        <span
          className="inline-flex shrink-0 items-center gap-1"
          title="Aguardando a aprovação do cliente; sem resposta, fecha nesta data (D-042)"
        >
          <Hourglass className="size-3" aria-hidden />
          aprovação até {aprovacao}
        </span>
      )}
    </p>
  );
}

/** Sinais discretos ao lado do título: IA silenciada, reaberturas. */
function Indicadores({ chamado: c }: { chamado: FilaChamadoItem }) {
  if (!c.ia_silenciada && c.reaberto_count === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
      {c.ia_silenciada && (
        <span title="IA silenciada neste chamado" className="inline-flex">
          <BotOff className="size-3.5" aria-hidden />
          <span className="sr-only">IA silenciada</span>
        </span>
      )}
      {c.reaberto_count > 0 && (
        <span
          title={`Reaberto ${c.reaberto_count} ${c.reaberto_count === 1 ? 'vez' : 'vezes'}`}
          className="inline-flex items-center gap-0.5 text-xs tabular-nums"
        >
          <RotateCcw className="size-3" aria-hidden />
          {c.reaberto_count}
          <span className="sr-only"> reaberturas</span>
        </span>
      )}
    </span>
  );
}

/**
 * Responsável com iniciais; "Assumir" só faz sentido em chamado EM ABERTO que
 * não é meu. Sem responsável: sempre visível (é a ação mais comum). De outro
 * operador: aparece no hover/foco da linha em telas com mouse (tomar o chamado
 * de alguém é exceção) e sempre em telas de toque.
 */
function Responsavel({ chamado: c, euId }: { chamado: FilaChamadoItem; euId: string }) {
  const aberto = (STATUS_ABERTOS as readonly StatusChamado[]).includes(c.status);
  const podeAssumir = aberto && c.operador_id !== euId;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {c.operador_nome ? (
        <>
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold',
              c.operador_id === euId
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}
            aria-hidden
          >
            {iniciais(c.operador_nome)}
          </span>
          <span className="truncate text-sm">
            {c.operador_id === euId ? 'Você' : c.operador_nome}
          </span>
        </>
      ) : (
        <span className="truncate text-xs text-muted-foreground/80 italic">Não atribuído</span>
      )}
      {podeAssumir && (
        <BotaoAssumir
          chamadoId={c.id}
          compacto
          className={cn(
            'relative z-10 ml-auto', // z-10: acima do link esticado da lista compacta
            c.operador_id &&
              'pointer-fine:opacity-0 pointer-fine:group-focus-within/linha:opacity-100 pointer-fine:group-hover/linha:opacity-100 pointer-fine:focus-visible:opacity-100',
          )}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------- Lista (< xl)

/**
 * Abaixo de `xl` a tabela vira lista: mesma informação essencial (título,
 * solicitante · alvo, status, prioridade, natureza, custo, responsável,
 * atualização), sem rolagem horizontal.
 */
function ListaFilaCompacta({ itens, euId }: { itens: FilaChamadoItem[]; euId: string }) {
  return (
    <ul className="divide-y xl:hidden">
      {itens.map((c) => (
        <li
          key={c.id}
          className="group/linha relative flex flex-col gap-2 px-3 py-3 transition-colors hover:bg-muted/50 sm:px-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  #{c.numero}
                </span>
                <Link
                  href={`/app/chamados/${c.id}`}
                  className="line-clamp-2 font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring/60 focus-visible:after:ring-inset"
                >
                  {c.titulo}
                </Link>
              </p>
              <LinhaSecundaria chamado={c} />
            </div>
            <time
              dateTime={new Date(c.updated_at).toISOString()}
              title={dataHora(c.updated_at)}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {tempoRelativo(c.updated_at)}
            </time>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={c.status} />
            <PrioridadeBadge prioridade={c.prioridade} />
            <NaturezaBadge natureza={c.natureza} className="hidden sm:inline-flex" />
            {c.custo_final != null ? (
              <CustoFinalBadge valor={c.custo_final} className="hidden md:inline-flex" />
            ) : (
              c.estimativa_custo && (
                <EstimativaCustoBadge
                  estimativa={c.estimativa_custo}
                  className="hidden md:inline-flex"
                />
              )
            )}
            <Indicadores chamado={c} />
            <div className="ml-auto max-w-[60%] min-w-0">
              <Responsavel chamado={c} euId={euId} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- Rodapé

function Rodape({
  estado,
  total,
  itensNaPagina,
  temMais,
}: {
  estado: EstadoFila;
  total: number;
  itensNaPagina: number;
  temMais: boolean;
}) {
  const { de, ate } = faixaDaPagina(estado.pagina, estado.por, itensNaPagina);
  const ultimaAlcancavel = Math.floor(OFFSET_MAX_FILA / estado.por) + 1;
  const totalPaginas = Math.max(1, Math.min(Math.ceil(total / estado.por), ultimaAlcancavel));
  const noTeto = !temMais && ate < total;
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <p className="text-xs text-muted-foreground tabular-nums">
        {fmtNumero.format(de)}–{fmtNumero.format(ate)} de {fmtNumero.format(total)}
        {noTeto && ' · refine os filtros ou exporte para ver o restante'}
      </p>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <SeletorPorPagina estado={estado} />
        <nav aria-label="Paginação" className="flex items-center gap-1.5">
          <LinkPagina
            href={estado.pagina > 1 ? hrefFila(estado, { pagina: estado.pagina - 1 }) : null}
            rotulo="Página anterior"
          >
            <ChevronLeft />
          </LinkPagina>
          <span className="px-1 text-xs text-muted-foreground tabular-nums" aria-current="page">
            {estado.pagina} / {totalPaginas}
          </span>
          <LinkPagina
            href={temMais ? hrefFila(estado, { pagina: estado.pagina + 1 }) : null}
            rotulo="Próxima página"
          >
            <ChevronRight />
          </LinkPagina>
        </nav>
      </div>
    </div>
  );
}

function LinkPagina({
  href,
  rotulo,
  children,
}: {
  href: string | null;
  rotulo: string;
  children: React.ReactNode;
}) {
  const cls = buttonVariants({ variant: 'outline', size: 'icon-sm' });
  if (!href) {
    return (
      <span
        aria-disabled="true"
        aria-label={rotulo}
        className={cn(cls, 'pointer-events-none opacity-50')}
      >
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={rotulo} className={cls}>
      {children}
    </Link>
  );
}

// -------------------------------------------------------------- Vazio

function VazioFila({
  estado,
  temFiltro,
  totalRecorte,
}: {
  estado: EstadoFila;
  temFiltro: boolean;
  totalRecorte: number;
}) {
  // Página além do fim (a fila encolheu desde que o link foi gerado).
  if (estado.pagina > 1 && totalRecorte > 0) {
    return (
      <EstadoVazio
        titulo="Esta página não existe mais"
        descricao="A fila mudou desde que você abriu este link."
        acao={{ href: hrefFila(estado, { pagina: 1 }), rotulo: 'Ir para a primeira página' }}
      />
    );
  }
  if (temFiltro) {
    return (
      <EstadoVazio
        titulo="Nenhum chamado com esses filtros"
        descricao="Ajuste ou limpe os filtros para ver mais resultados."
        acao={{
          href: hrefFila(estadoLimpo(estado)),
          rotulo: 'Limpar filtros',
        }}
      />
    );
  }
  // Sem filtro, a fila ainda está recortada por situação: dizer "nenhum chamado
  // ainda" com 22 chamados fechados no tenant seria mentira (D-030).
  if (estado.situacao === 'abertos') {
    return (
      <EstadoVazio
        titulo="Nenhum chamado em aberto"
        descricao="A fila está limpa. Veja “Encerrados” ou “Todos” para o histórico."
      />
    );
  }
  if (estado.situacao === 'encerrados') {
    return (
      <EstadoVazio
        titulo="Nenhum chamado encerrado"
        descricao="Chamados resolvidos, fechados ou cancelados aparecem aqui."
      />
    );
  }
  return (
    <EstadoVazio
      titulo="Nenhum chamado ainda"
      descricao="Quando um cliente abrir um chamado, ele aparece aqui."
      acao={{ href: '/app/chamados/novo', rotulo: 'Abrir um chamado' }}
    />
  );
}

function EstadoVazio({
  titulo,
  descricao,
  acao,
}: {
  titulo: string;
  descricao: string;
  acao?: { href: string; rotulo: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{titulo}</p>
        <p className="text-sm text-muted-foreground">{descricao}</p>
      </div>
      {acao && (
        <Link href={acao.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {acao.rotulo}
        </Link>
      )}
    </div>
  );
}
