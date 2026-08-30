'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  STATUS_ABERTOS,
  STATUS_ENCERRADOS,
  type SituacaoChamado,
} from '@chamados/shared';
import type { ContadoresFila } from '@chamados/db';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from '@/lib/rotulos';
import { cn } from '@/lib/utils';

const SELECT_CLS =
  'h-8 rounded-lg border border-input bg-card px-2.5 text-sm shadow-campo outline-none transition-[color,box-shadow] hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

interface Opcao {
  id: string;
  nome: string;
}

interface Props {
  atual: {
    situacao: SituacaoChamado;
    status: string;
    natureza: string;
    prioridade: string;
    complexidade: string;
    atribuicao: string;
    sistema_alvo_id: string;
    categoria_id: string;
    busca: string;
  };
  contadores: ContadoresFila;
  sistemas: Opcao[];
  categorias: Opcao[];
}

/** Filtros rápidos de situação (D-030): o recorte que a equipe usa o dia inteiro. */
const SITUACOES: { valor: SituacaoChamado; rotulo: string }[] = [
  { valor: 'abertos', rotulo: 'Em aberto' },
  { valor: 'encerrados', rotulo: 'Encerrados' },
  { valor: 'todos', rotulo: 'Todos' },
];

export function FilaFiltros({ atual, contadores, sistemas, categorias }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busca, setBusca] = useState(atual.busca);

  function navegar(mudancas: Record<string, string | null>) {
    const p = new URLSearchParams(searchParams.toString());
    // A situação padrão depende de `q`/`status` (ver page.tsx): a partir da
    // primeira interação ela vai explícita, para não mudar sozinha depois.
    p.set('situacao', atual.situacao);
    for (const [chave, valor] of Object.entries(mudancas)) {
      if (valor === null || valor === '') p.delete(chave);
      else p.set(chave, valor);
    }
    p.delete('cursor'); // mudança de filtro reseta a paginação keyset
    const qs = p.toString();
    router.push(qs ? `/app/chamados?${qs}` : '/app/chamados');
  }

  const temFiltro =
    atual.situacao !== 'abertos' ||
    atual.status ||
    atual.natureza ||
    atual.prioridade ||
    atual.complexidade ||
    (atual.atribuicao && atual.atribuicao !== 'todos') ||
    atual.sistema_alvo_id ||
    atual.categoria_id ||
    atual.busca;

  const contaSituacao = (s: SituacaoChamado) =>
    s === 'todos' ? contadores.porSituacao.total : contadores.porSituacao[s];

  // O dropdown de status oferece só os status da situação escolhida — a interseção
  // "Em aberto + Fechado" não existe e não deve ser oferecida —, e só os que têm
  // chamado (opção que filtra para zero não é opção). O status atual entra sempre,
  // mesmo vazio ou fora do grupo, para o select nunca ficar sem o próprio valor.
  const statusDaSituacao =
    atual.situacao === 'abertos'
      ? STATUS_ABERTOS
      : atual.situacao === 'encerrados'
        ? STATUS_ENCERRADOS
        : [...STATUS_ABERTOS, ...STATUS_ENCERRADOS];
  const statusOpcoes = statusDaSituacao.filter(
    (s) => contadores.porStatus[s] > 0 || atual.status === s,
  );
  if (atual.status && !statusOpcoes.includes(atual.status as StatusChamado)) {
    statusOpcoes.push(atual.status as StatusChamado);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Busca full-text (título + descrição, com ranking) — specs/04 §10.4 */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          navegar({ q: busca.trim() || null });
        }}
        className="relative w-full max-w-md"
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          name="q"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por número, título ou descrição…"
          aria-label="Buscar chamados"
          className="h-9 w-full rounded-lg border border-input bg-card pr-3 pl-8 text-sm shadow-campo outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      </form>

      {/* Três filtros rápidos de situação — D-030 */}
      <div
        role="group"
        aria-label="Situação dos chamados"
        className="flex flex-wrap items-center gap-1.5"
      >
        {SITUACOES.map((s) => (
          <Chip
            key={s.valor}
            rotulo={s.rotulo}
            contador={contaSituacao(s.valor)}
            ativo={atual.situacao === s.valor}
            onClick={() => navegar({ situacao: s.valor, status: null })}
          />
        ))}
      </div>

      {/* Demais dimensões: só dropdowns */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="f-atribuicao">
          Atribuição
        </label>
        <select
          id="f-atribuicao"
          className={SELECT_CLS}
          value={atual.atribuicao === 'todos' ? '' : atual.atribuicao}
          onChange={(e) => navegar({ atribuicao: e.target.value || null })}
        >
          <option value="">Qualquer atribuição ({contadores.total})</option>
          <option value="meus">Meus ({contadores.meus})</option>
          <option value="nao_atribuidos">Não atribuídos ({contadores.naoAtribuidos})</option>
        </select>

        <label className="sr-only" htmlFor="f-status">
          Status
        </label>
        <select
          id="f-status"
          className={SELECT_CLS}
          value={atual.status}
          onChange={(e) => navegar({ status: e.target.value || null })}
        >
          <option value="">Qualquer status</option>
          {statusOpcoes.map((s) => (
            <option key={s} value={s}>
              {ROTULO_STATUS_CHAMADO[s]} ({contadores.porStatus[s]})
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="f-natureza">
          Natureza
        </label>
        <select
          id="f-natureza"
          className={SELECT_CLS}
          value={atual.natureza}
          onChange={(e) => navegar({ natureza: e.target.value || null })}
        >
          <option value="">Toda natureza</option>
          {Object.values(Natureza).map((n) => (
            <option key={n} value={n}>
              {ROTULO_NATUREZA[n]}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="f-prioridade">
          Prioridade
        </label>
        <select
          id="f-prioridade"
          className={SELECT_CLS}
          value={atual.prioridade}
          onChange={(e) => navegar({ prioridade: e.target.value || null })}
        >
          <option value="">Toda prioridade</option>
          {Object.values(Prioridade).map((p) => (
            <option key={p} value={p}>
              {ROTULO_PRIORIDADE[p]}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="f-complexidade">
          Complexidade
        </label>
        <select
          id="f-complexidade"
          className={SELECT_CLS}
          value={atual.complexidade}
          onChange={(e) => navegar({ complexidade: e.target.value || null })}
        >
          <option value="">Toda complexidade</option>
          {Object.values(Complexidade).map((c) => (
            <option key={c} value={c}>
              {ROTULO_COMPLEXIDADE[c]}
            </option>
          ))}
        </select>

        {sistemas.length > 0 && (
          <>
            <label className="sr-only" htmlFor="f-sistema">
              Sistema-alvo
            </label>
            <select
              id="f-sistema"
              className={SELECT_CLS}
              value={atual.sistema_alvo_id}
              onChange={(e) => navegar({ sistema: e.target.value || null, categoria: null })}
            >
              <option value="">Todo sistema-alvo</option>
              {sistemas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
          </>
        )}

        {categorias.length > 0 && (
          <>
            <label className="sr-only" htmlFor="f-categoria">
              Categoria
            </label>
            <select
              id="f-categoria"
              className={SELECT_CLS}
              value={atual.categoria_id}
              onChange={(e) => navegar({ categoria: e.target.value || null, sistema: null })}
            >
              <option value="">Toda categoria</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </>
        )}

        {atual.busca && (
          <span className="inline-flex items-center gap-1 rounded-md border bg-muted/60 px-2 py-1 text-xs">
            Busca: “{atual.busca}”
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => {
                setBusca('');
                navegar({ q: null });
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        )}

        {temFiltro && (
          <button
            type="button"
            onClick={() => {
              setBusca('');
              router.push('/app/chamados');
            }}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Limpar filtros
          </button>
        )}
      </div>
    </div>
  );
}

function Chip({
  rotulo,
  contador,
  ativo,
  onClick,
}: {
  rotulo: string;
  contador?: number;
  ativo: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        ativo
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {rotulo}
      {contador !== undefined && (
        <span className={cn('tabular-nums', ativo ? 'opacity-80' : 'text-muted-foreground/70')}>
          {contador}
        </span>
      )}
    </button>
  );
}
