import Link from 'next/link';
import { ArrowRight, Inbox } from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  listarFilaChamados,
  contarFila,
  listarSistemasAlvo,
  listarCategorias,
  type FiltrosFila,
} from '@chamados/db';
import { StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { buttonVariants } from '@/components/ui/button';
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
  ComplexidadeBadge,
  NaturezaBadge,
} from '@/components/chamado/badges';
import { tempoRelativo } from '@/lib/tempo';
import { FilaFiltros } from './filtros';
import { BotaoAssumir } from './acoes-linha';

type ParamsBrutos = Record<string, string | string[] | undefined>;

function um(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function valido<T extends string>(v: string, valores: readonly T[]): T | undefined {
  return (valores as readonly string[]).includes(v) ? (v as T) : undefined;
}

const ATRIBUICOES = ['meus', 'nao_atribuidos', 'todos'] as const;

export default async function FilaPage({ searchParams }: { searchParams: Promise<ParamsBrutos> }) {
  const { usuario, tenant } = await exigirUsuario();
  const sp = await searchParams;

  const busca = um(sp.q).trim();
  const status = valido(um(sp.status), Object.values(StatusChamado));
  const natureza = valido(um(sp.natureza), Object.values(Natureza));
  const prioridade = valido(um(sp.prioridade), Object.values(Prioridade));
  const complexidade = valido(um(sp.complexidade), Object.values(Complexidade));
  const atribuicao = valido(um(sp.atribuicao), ATRIBUICOES) ?? 'todos';
  const sistema_alvo_id = um(sp.sistema);
  const categoria_id = um(sp.categoria);
  const cursor = um(sp.cursor);

  const filtros: FiltrosFila = {
    busca: busca || undefined,
    status,
    natureza,
    prioridade,
    complexidade,
    atribuicao,
    sistema_alvo_id: sistema_alvo_id || undefined,
    categoria_id: categoria_id || undefined,
    cursor: cursor || undefined,
    limite: 25,
  };

  const ds = await obterAppDataSource();
  const { pagina, contadores, sistemas, categorias } = await runInTenantContext(
    ds,
    tenant.id,
    async (em) => ({
      pagina: await listarFilaChamados(em, usuario, filtros),
      contadores: await contarFila(em, usuario, filtros),
      sistemas: await listarSistemasAlvo(em),
      categorias: await listarCategorias(em),
    }),
  );

  // Preserva os filtros ao paginar (keyset forward-only).
  const paramsBase = new URLSearchParams();
  for (const [k, v] of Object.entries({
    q: busca,
    status: status ?? '',
    natureza: natureza ?? '',
    prioridade: prioridade ?? '',
    complexidade: complexidade ?? '',
    atribuicao: atribuicao === 'todos' ? '' : atribuicao,
    sistema: sistema_alvo_id,
    categoria: categoria_id,
  })) {
    if (v) paramsBase.set(k, v);
  }
  const hrefProxima = (() => {
    if (!pagina.proximoCursor) return null;
    const p = new URLSearchParams(paramsBase);
    p.set('cursor', pagina.proximoCursor);
    return `/app/chamados?${p.toString()}`;
  })();
  const hrefInicio = paramsBase.toString()
    ? `/app/chamados?${paramsBase.toString()}`
    : '/app/chamados';

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Chamados</h1>
        <p className="text-sm text-muted-foreground">
          Fila de atendimento de {tenant.nome_exibicao}. Filtre, priorize e assuma chamados.
        </p>
      </div>

      <FilaFiltros
        atual={{
          status: status ?? '',
          natureza: natureza ?? '',
          prioridade: prioridade ?? '',
          complexidade: complexidade ?? '',
          atribuicao,
          sistema_alvo_id,
          categoria_id,
          busca,
        }}
        contadores={contadores}
        sistemas={sistemas.map((s) => ({ id: s.id, nome: s.nome }))}
        categorias={categorias.map((c) => ({ id: c.id, nome: c.nome }))}
      />

      {pagina.itens.length === 0 ? (
        <VazioFila temFiltro={Boolean(paramsBase.toString())} hrefLimpar="/app/chamados" />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14">Nº</TableHead>
                <TableHead className="min-w-[220px]">Título</TableHead>
                <TableHead>Solicitante</TableHead>
                <TableHead>Alvo</TableHead>
                <TableHead>Natureza</TableHead>
                <TableHead>Prioridade</TableHead>
                <TableHead>Complex.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Operador</TableHead>
                <TableHead>Atualizado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagina.itens.map((c) => {
                const atribuidoAMim = c.operador_id === usuario.id;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      #{c.numero}
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <Link
                        href={`/app/chamados/${c.id}`}
                        className="font-medium hover:underline"
                        title={c.titulo}
                      >
                        <span className="line-clamp-1">{c.titulo}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.solicitante_nome ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.sistema_nome ?? c.categoria_nome ?? '—'}
                    </TableCell>
                    <TableCell>
                      <NaturezaBadge natureza={c.natureza} />
                    </TableCell>
                    <TableCell>
                      <PrioridadeBadge prioridade={c.prioridade} />
                    </TableCell>
                    <TableCell>
                      {c.complexidade ? (
                        <ComplexidadeBadge complexidade={c.complexidade} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.operador_nome ?? (
                        <span className="italic text-muted-foreground/70">não atribuído</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {tempoRelativo(c.updated_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        {!atribuidoAMim && <BotaoAssumir chamadoId={c.id} />}
                        <Link
                          href={`/app/chamados/${c.id}`}
                          aria-label={`Abrir chamado #${c.numero}`}
                          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                        >
                          <ArrowRight className="size-4" />
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {(hrefProxima || cursor) && (
        <div className="flex items-center justify-between">
          {cursor ? (
            <Link href={hrefInicio} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              ← Início
            </Link>
          ) : (
            <span />
          )}
          {hrefProxima && (
            <Link href={hrefProxima} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Próxima página
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function VazioFila({ temFiltro, hrefLimpar }: { temFiltro: boolean; hrefLimpar: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {temFiltro ? 'Nenhum chamado com esses filtros' : 'Nenhum chamado ainda'}
        </p>
        <p className="text-sm text-muted-foreground">
          {temFiltro
            ? 'Ajuste ou limpe os filtros para ver mais resultados.'
            : 'Quando um cliente abrir um chamado, ele aparece aqui.'}
        </p>
      </div>
      {temFiltro && (
        <Link href={hrefLimpar} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Limpar filtros
        </Link>
      )}
    </div>
  );
}
