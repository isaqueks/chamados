import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FiltrosFilaDto, LinhaFilaDto } from '@comum/dto';
import { CarregandoTela, ErroTela, Faixa } from '@/componentes/execucao/suporte';
import { useComando } from '@/componentes/apoio/comando';
import { useAtalhos } from '@/componentes/fila/atalhos-teclado';
import {
  DialogoImplementar,
  DialogoLote,
  precisaDialogoImplementar,
  useImplementar,
} from '@/componentes/fila/dialogos-fila';
import { FiltrosFila } from '@/componentes/fila/filtros-fila';
import {
  STATUS_PADRAO_FILA,
  alternarSelecao,
  celulaForja,
  filtrarEmMemoria,
  haQuantoTempo,
  ordenarLinhas,
  podarSelecao,
  selecionavel,
} from '@/componentes/fila/logica-fila';
import { PainelChamado } from '@/componentes/fila/painel-chamado';
import { TabelaFila } from '@/componentes/fila/tabela-fila';
import {
  OnboardingFila,
  VazioSemChamados,
  VazioSemMapeamento,
} from '@/componentes/fila/vazio-fila';
import { useProjetoAtual } from '@/componentes/shell/projeto-atual';
import { api, urlRota } from '@/lib/api';
import { horaLocal } from '@/lib/formato';
import { assinarSse } from '@/lib/sse';
import { Button, buttonVariants } from '@/ui/button';

/**
 * Fila — specs/forja/06 §4.1: "o que dá para implementar agora, e o que está
 * em andamento?".
 *
 * Os chamados vêm do `chamado_cache` sincronizado pelo backend (o token nunca
 * chega ao navegador, F-15). Status/natureza/prioridade vão ao servidor; a
 * complexidade, a busca e "só implementáveis" são filtradas em memória
 * (resposta imediata; complexidade até D-036 L3). Ordenação default:
 * prioridade desc + atualização recente.
 *
 * Ao vivo: os eventos `execucao.estado` e `chamado.sinal` do canal global
 * (01 §8.1) refazem a lista. Uma ação primária por tela (06 §6): Implementar.
 * Com o Chamados fora do ar, a fila mostra o cache esmaecido, desabilita
 * Implementar e diz o MOTIVO real (erro da sessão/sincronização) com link para
 * a Conexão (FJ-031). A IA do servidor não interfere: o badge é informativo.
 *
 * Teclado (06 §9): `j`/`k` navegar, `x` selecionar, `Enter` abrir.
 */

const TIPOS_QUE_MUDAM_A_FILA = new Set(['execucao.estado', 'chamado.sinal']);

export function TelaFila() {
  const navegar = useNavigate();
  const clienteQuery = useQueryClient();
  const { projetoId } = useProjetoAtual();
  const [filtros, setFiltros] = useState<FiltrosFilaDto>({ status: STATUS_PADRAO_FILA });
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [painel, setPainel] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<LinhaFilaDto | null>(null);
  const [loteAberto, setLoteAberto] = useState(false);
  const [agora, setAgora] = useState(() => new Date());

  const entradaServidor: FiltrosFilaDto = {
    projeto_id: projetoId ?? undefined,
    status: filtros.status,
    natureza: filtros.natureza,
    prioridade: filtros.prioridade,
  };
  const fila = useQuery({
    queryKey: ['fila', entradaServidor],
    queryFn: ({ signal }) => api('fila_listar', { entrada: entradaServidor, sinal: signal }),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const assinatura = assinarSse({
      caminho: urlRota('eventos_global'),
      aoEvento: (e) => {
        if (!TIPOS_QUE_MUDAM_A_FILA.has(e.tipo) || timer) return;
        timer = setTimeout(() => {
          timer = null;
          void clienteQuery.invalidateQueries({ queryKey: ['fila'] });
        }, 500);
      },
      aoRecarregar: () => void clienteQuery.invalidateQueries({ queryKey: ['fila'] }),
    });
    return () => {
      if (timer) clearTimeout(timer);
      assinatura.fechar();
    };
  }, [clienteQuery]);

  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const sincronizar = useComando({
    executar: () => api('fila_sincronizar', { entrada: { projeto_id: projetoId ?? undefined } }),
    invalidar: [['fila']],
    // O erro tipado (503) vira a faixa abaixo: a lista relida traz o motivo.
    aoErro: () => void clienteQuery.invalidateQueries({ queryKey: ['fila'] }),
  });
  const implementar = useImplementar(fila.data?.projeto?.id ?? projetoId);

  const linhas = useMemo(
    () =>
      ordenarLinhas(
        filtrarEmMemoria(fila.data?.itens ?? [], {
          complexidade: filtros.complexidade,
          busca: filtros.busca,
          so_implementaveis: filtros.so_implementaveis,
        }),
      ),
    [fila.data, filtros.complexidade, filtros.busca, filtros.so_implementaveis],
  );

  useEffect(() => {
    setSelecao((s) => podarSelecao(s, linhas));
    setCursor((c) => Math.min(c, Math.max(0, linhas.length - 1)));
  }, [linhas]);

  const doCache = fila.data?.fonte === 'cache';

  function abrir(l: LinhaFilaDto): void {
    const c = celulaForja(l);
    if (c.tipo === 'em_voo' || c.tipo === 'aprovar') navegar(c.href);
    else setPainel(l.chamado.chamado_id);
  }

  function pedirImplementar(l: LinhaFilaDto): void {
    if (doCache || !selecionavel(l)) return;
    if (precisaDialogoImplementar(l)) setConfirmar(l);
    else implementar.mutate({ linha: l, ignorarPrIa: false });
  }

  useAtalhos({
    j: () => setCursor((c) => Math.min(c + 1, Math.max(0, linhas.length - 1))),
    k: () => setCursor((c) => Math.max(0, c - 1)),
    x: () => {
      const l = linhas[cursor];
      if (l && selecionavel(l) && !doCache)
        setSelecao((s) => alternarSelecao(s, l.chamado.chamado_id));
    },
    Enter: () => {
      const l = linhas[cursor];
      if (l) abrir(l);
    },
  });

  if (fila.isLoading) return <CarregandoTela />;
  if (fila.error || !fila.data)
    return <ErroTela erro={fila.error} titulo="Não foi possível carregar a fila" />;

  const f = fila.data;
  const semProjeto = !f.projeto;
  const sincronizadoHa = haQuantoTempo(f.sincronizado_em, agora);
  const temFiltro =
    (filtros.natureza?.length ?? 0) > 0 ||
    (filtros.prioridade?.length ?? 0) > 0 ||
    (filtros.complexidade?.length ?? 0) > 0 ||
    !!filtros.busca?.trim() ||
    !!filtros.so_implementaveis;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Fila{f.projeto ? ` · ${f.projeto.nome}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground">
          O que dá para implementar agora, e o que está em andamento.
        </p>
      </div>

      {semProjeto ? (
        <OnboardingFila />
      ) : !f.projeto!.tem_mapeamento ? (
        <VazioSemMapeamento projetoId={f.projeto!.id} />
      ) : (
        <>
          <FiltrosFila
            filtros={filtros}
            contagens={f.contagens}
            aoMudar={setFiltros}
            sincronizadoHa={sincronizadoHa}
            sincronizando={sincronizar.isPending}
            aoSincronizar={() => sincronizar.mutate(undefined)}
          />

          {doCache && (
            <Faixa
              tom="aviso"
              titulo={`Dados de ${horaLocal(f.sincronizado_em) ?? '—'}; o Chamados não respondeu`}
              acoes={
                <Link to="/conexao" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Conexão
                </Link>
              }
            >
              {f.erro_sincronizacao && <span>{f.erro_sincronizacao.mensagem}</span>}
              <span>Implementar fica desabilitado até a próxima sincronização.</span>
            </Faixa>
          )}

          {selecao.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/60 px-3 py-2 text-sm">
              <span>
                {selecao.size} {selecao.size === 1 ? 'selecionado' : 'selecionados'}
              </span>
              <Button size="sm" onClick={() => setLoteAberto(true)}>
                Implementar em lote ({selecao.size})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelecao(new Set())}>
                Limpar seleção
              </Button>
            </div>
          )}

          {linhas.length === 0 ? (
            <VazioSemChamados
              aoLimparFiltros={() => setFiltros({ status: STATUS_PADRAO_FILA })}
              aoVerTodosStatus={() => setFiltros({ ...filtros, status: [] })}
            />
          ) : (
            <TabelaFila
              linhas={linhas}
              selecao={selecao}
              aoMudarSelecao={setSelecao}
              cursor={cursor}
              aoMudarCursor={setCursor}
              aoAbrir={abrir}
              aoImplementar={pedirImplementar}
              implementandoId={
                implementar.isPending
                  ? (implementar.variables?.linha.chamado.chamado_id ?? null)
                  : null
              }
              desabilitada={doCache}
            />
          )}
          {temFiltro && linhas.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {linhas.length} de {f.itens.length} chamados com os filtros atuais.
            </p>
          )}
        </>
      )}

      <PainelChamado chamadoId={painel} aoFechar={() => setPainel(null)} />
      <DialogoImplementar
        linha={confirmar}
        aoFechar={() => setConfirmar(null)}
        pendente={implementar.isPending}
        aoConfirmar={(ignorarPrIa) => {
          if (confirmar) implementar.mutate({ linha: confirmar, ignorarPrIa });
        }}
      />
      <DialogoLote
        aberto={loteAberto}
        aoFechar={() => setLoteAberto(false)}
        projetoId={f.projeto?.id ?? projetoId}
        chamadoIds={[...selecao]}
      />
    </div>
  );
}
