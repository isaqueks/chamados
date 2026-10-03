import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { HistoryIcon, ImageOffIcon } from 'lucide-react';
import type { MetricasHistoricoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { formatarCustoEquivalente } from '@/lib/formato';
import { buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { EstadoExecucaoBadge } from '@/componentes/badges';
import { useProjetoAtual } from '@/componentes/shell/projeto-atual';
import { Caixa, CampoSelect } from '@/componentes/apoio/campos';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
  RotuloCalculado,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { formatarDataHora, shaCurto } from '@/componentes/apoio/texto';
import { BotaoApagarDados } from '@/componentes/historico/apagar-dados';
import {
  filtrosHistorico,
  formatarDuracao,
  formatarTaxa,
  ordenarHistorico,
  podeApagarDados,
  RESULTADOS,
  ROTULO_PERIODO,
  type Periodo,
  type ResultadoHistorico,
} from '@/componentes/historico/logica';

/**
 * Histórico (specs/forja/06 §4.11; métricas de 00 §10). Execuções encerradas
 * (`concluido`, `descartado`, `cancelado`) com filtros por projeto, período e
 * resultado. O detalhe reaproveita a Execução em modo somente leitura
 * (`/execucoes/:id`); daqui sai também "Apagar dados deste chamado…" (05 §11).
 * "Todos os projetos" vale aqui (06 §1.2), por isso o filtro de projeto é
 * local e começa no projeto atual do cabeçalho.
 */

const ROTULO_RESULTADO: Record<ResultadoHistorico, string> = {
  concluido: 'Concluídos',
  descartado: 'Descartados',
  cancelado: 'Cancelados',
};

const TODOS = '__todos__';

function Metricas({ m }: { m: MetricasHistoricoDto }) {
  const blocos: { rotulo: string; valor: string; dica?: string }[] = [
    { rotulo: 'Aprovados sem ajuste', valor: formatarTaxa(m.taxa_aprovacao_sem_ajuste) },
    {
      rotulo: 'Ciclos médios',
      valor: m.ciclos_medios
        ? `${m.ciclos_medios.auto.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} auto · ${m.ciclos_medios.humano.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} humano`
        : '—',
    },
    {
      rotulo: 'Custo médio',
      valor:
        m.custo_medio_micro_usd === null ? '—' : formatarCustoEquivalente(m.custo_medio_micro_usd),
      dica: 'estimativa da CLI a preço de API, não é cobrança da assinatura',
    },
    { rotulo: 'Até aguardar você', valor: formatarDuracao(m.tempo_ate_aguardando_ms) },
    { rotulo: 'Perguntaram ao cliente', valor: formatarTaxa(m.taxa_pergunta_cliente) },
    { rotulo: 'Concluídos', valor: formatarTaxa(m.taxa_conclusao) },
    { rotulo: 'Relatório contradisse o diff', valor: formatarTaxa(m.taxa_incoerencia_relatorio) },
    { rotulo: 'Condutor editou sozinho', valor: formatarTaxa(m.taxa_condutor_editou) },
    { rotulo: 'Mensagem barrada pelo validador', valor: formatarTaxa(m.taxa_mensagem_barrada) },
  ];
  return (
    <Card className="gap-3 py-4">
      <div className="flex items-center gap-2 px-4">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Métricas do período
        </span>
        <RotuloCalculado />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 sm:grid-cols-3 lg:grid-cols-5">
        {blocos.map((b) => (
          <div key={b.rotulo} title={b.dica}>
            <dt className="text-xs text-muted-foreground">{b.rotulo}</dt>
            <dd className="text-sm font-medium tabular-nums">{b.valor}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function TelaHistorico() {
  const { projetoId: projetoAtual } = useProjetoAtual();
  const [projetoId, setProjetoId] = useState<string | null>(projetoAtual);
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [resultados, setResultados] = useState<Set<ResultadoHistorico>>(new Set(RESULTADOS));

  const filtros = useMemo(
    () => filtrosHistorico({ projetoId, periodo, resultados }),
    // O instante de "agora" é fixado quando os filtros mudam (evita refetch a cada render).
    [projetoId, periodo, resultados],
  );
  const chave = ['historico', filtros];

  const projetos = useQuery({
    queryKey: ['projetos'],
    queryFn: ({ signal }) => api('projetos_listar', { sinal: signal }),
  });
  const worktrees = useQuery({
    queryKey: ['worktrees'],
    queryFn: ({ signal }) => api('worktrees_listar', { sinal: signal }),
  });
  const consulta = useQuery({
    queryKey: chave,
    queryFn: ({ signal }) => api('historico_listar', { entrada: filtros, sinal: signal }),
  });

  const orfas = worktrees.data?.worktrees.filter((w) => w.orfa).length ?? 0;
  const itens = ordenarHistorico(consulta.data?.itens ?? []);

  return (
    <Pagina largura="larga">
      <CabecalhoPagina
        titulo="Histórico"
        descricao="Execuções encerradas: o que foi entregue, descartado ou cancelado, e quanto custou."
        acoes={
          <Link to="/historico/worktrees" className={buttonVariants({ variant: 'outline' })}>
            Worktrees{orfas > 0 ? ` (${orfas} órfãs)` : ''}
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <CampoSelect
          rotuloAcessivel="Projeto"
          className="w-56"
          valor={projetoId ?? TODOS}
          opcoes={[
            { valor: TODOS, rotulo: 'Todos os projetos' },
            ...(projetos.data?.projetos ?? []).map((p) => ({ valor: p.id, rotulo: p.nome })),
          ]}
          aoMudar={(v) => setProjetoId(v === TODOS ? null : v)}
        />
        <CampoSelect
          rotuloAcessivel="Período"
          className="w-48"
          valor={periodo}
          opcoes={(Object.keys(ROTULO_PERIODO) as Periodo[]).map((p) => ({
            valor: p,
            rotulo: ROTULO_PERIODO[p],
          }))}
          aoMudar={setPeriodo}
        />
        <div className="flex flex-wrap items-center gap-4" role="group" aria-label="Resultado">
          {RESULTADOS.map((r) => (
            <Caixa
              key={r}
              marcada={resultados.has(r)}
              rotulo={ROTULO_RESULTADO[r]}
              aoMudar={(m) =>
                setResultados((s) => {
                  const n = new Set(s);
                  if (m) n.add(r);
                  else n.delete(r);
                  return n;
                })
              }
            />
          ))}
        </div>
      </div>

      {consulta.isPending ? (
        <Carregando linhas={6} />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : (
        <>
          {consulta.data && <Metricas m={consulta.data.metricas} />}
          {itens.length === 0 ? (
            <Vazio
              icone={HistoryIcon}
              titulo="Nenhuma execução encerrada ainda."
              descricao={
                resultados.size < RESULTADOS.length || periodo !== 'tudo' || projetoId
                  ? 'Nada com estes filtros. Amplie o período ou marque todos os resultados.'
                  : undefined
              }
            />
          ) : (
            <Card className="gap-0 py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chamado</TableHead>
                    <TableHead>Resultado</TableHead>
                    <TableHead>Concluída</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="text-right">Ciclos</TableHead>
                    <TableHead>Entrega</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {itens.map((l) => (
                    <TableRow key={l.execucao_id}>
                      <TableCell className="max-w-80">
                        <Link
                          to={`/execucoes/${l.execucao_id}`}
                          className="block truncate font-medium hover:underline"
                          title={l.titulo}
                        >
                          <span className="tabular-nums">#{l.numero}</span> {l.titulo}
                        </Link>
                        <span className="text-xs text-muted-foreground">{l.projeto_nome}</span>
                      </TableCell>
                      <TableCell>
                        <EstadoExecucaoBadge estado={l.estado} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground tabular-nums">
                        {formatarDataHora(l.concluido_em)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {formatarCustoEquivalente(l.custo_micro_usd)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {l.ciclo_total}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {l.sha_merge ? `merge ${shaCurto(l.sha_merge)}` : '—'}
                        {l.patch_id && (
                          <span className="block" title={l.patch_id}>
                            patch {shaCurto(l.patch_id, 6)}
                          </span>
                        )}
                        {l.prints_expirados && (
                          <span
                            className="flex items-center gap-1 font-sans"
                            title="Prints removidos pela retenção"
                          >
                            <ImageOffIcon className="size-3" aria-hidden />
                            prints expirados
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Link
                            to={`/execucoes/${l.execucao_id}`}
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          >
                            Abrir
                          </Link>
                          {podeApagarDados(l.estado) && (
                            <BotaoApagarDados
                              execucaoId={l.execucao_id}
                              numero={l.numero}
                              invalidar={[['historico'], ['worktrees']]}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </Pagina>
  );
}
