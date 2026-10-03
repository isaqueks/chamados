import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { contaEmAguardandoVoce } from '@comum/estados';
import type { EventoForja } from '@comum/protocolo-eventos';
import {
  contarNegacoes,
  exigeRecarregarExecucao,
  mesclarEventos,
  semAtividadeHa,
} from '@/componentes/execucao/arvore-feed';
import { CabecalhoExecucao } from '@/componentes/execucao/cabecalho-execucao';
import { CartaoAprovarPlano, CartaoDecisao } from '@/componentes/execucao/cartoes-gate';
import { CartoesEstado } from '@/componentes/execucao/cartoes-estado';
import { ConversaChamado } from '@/componentes/execucao/conversa-chamado';
import { DialogoDescartar, DialogoParar } from '@/componentes/execucao/dialogos-execucao';
import { FeedAoVivo } from '@/componentes/execucao/feed-ao-vivo';
import { PainelPlano, PlanoCarregando } from '@/componentes/execucao/painel-plano';
import { CarregandoTela, ErroTela, Faixa } from '@/componentes/execucao/suporte';
import { execucaoEncerrada, mostraCartaoDecisao } from '@/componentes/execucao/acoes-execucao';
import { BotaoApagarDados } from '@/componentes/historico/apagar-dados';
import { podeApagarDados } from '@/componentes/historico/logica';
import { useComando } from '@/componentes/apoio/comando';
import { api, urlRota } from '@/lib/api';
import { ROTULO_ESTADO_EXECUCAO } from '@/lib/rotulos';
import { assinarSse } from '@/lib/sse';

/**
 * Execução do chamado — specs/forja/06 §4.2 ("o que o agente está fazendo e
 * por quê; como intervenho?").
 *
 * Dados: `GET /api/execucoes/:id` (retrato: estado, trilha, plano, conversa,
 * ações válidas) + `GET …/feed` (página persistida) e, a partir do
 * `ultimo_seq` dela, o SSE da execução (`…/eventos`, 01 §8.1) — sem lacuna e
 * sem duplicata (o `seq` é o `Last-Event-ID`). Eventos que mudam o retrato
 * (estado, etapa, commit, verificação, mensagem nova) refazem o GET; o resto
 * só entra no feed. `sistema.recarregar` refaz tudo.
 *
 * Notificações (06 §8): toast in-app quando a execução entra num estado que
 * conta em "Aguardando você" — só o número e o tipo, nunca texto do cliente.
 */

const LIMITE_FEED = 500;

export function TelaExecucao() {
  const { id = '' } = useParams();
  const clienteQuery = useQueryClient();
  const conversaRef = useRef<HTMLElement>(null);
  const [eventos, setEventos] = useState<EventoForja[]>([]);
  const [haMaisAntigos, setHaMaisAntigos] = useState(false);
  const [agora, setAgora] = useState(() => new Date());
  const [dialogo, setDialogo] = useState<'parar' | 'descartar' | null>(null);

  const execucao = useQuery({
    queryKey: ['execucao', id],
    queryFn: ({ signal }) => api('execucao_obter', { params: { id }, sinal: signal }),
    enabled: !!id,
    // Etapa rodando sem evento nenhum: o servidor decide "sem atividade" (limiar do
    // projeto) a cada GET — sem este refetch a faixa nunca apareceria.
    refetchInterval: (q) => (q.state.data?.grupo === 'trabalhando' ? 60_000 : false),
  });

  const feed = useQuery({
    queryKey: ['feed', id],
    queryFn: ({ signal }) =>
      api('execucao_feed', { params: { id }, entrada: { limite: LIMITE_FEED }, sinal: signal }),
    enabled: !!id,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!feed.data) return;
    setEventos((atuais) => mesclarEventos(atuais, feed.data.eventos));
    setHaMaisAntigos(feed.data.ha_mais_antigos);
  }, [feed.data]);

  const recarregarRetrato = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agendarRecarga = useCallback(() => {
    if (recarregarRetrato.current) return;
    recarregarRetrato.current = setTimeout(() => {
      recarregarRetrato.current = null;
      void clienteQuery.invalidateQueries({ queryKey: ['execucao', id] });
    }, 300);
  }, [clienteQuery, id]);

  const ultimoSeqInicial = feed.data?.ultimo_seq ?? null;
  const feedPronto = feed.isSuccess;
  useEffect(() => {
    if (!id || !feedPronto) return;
    const assinatura = assinarSse({
      caminho: urlRota('execucao_eventos', { id }),
      ultimoSeq: ultimoSeqInicial,
      aoEvento: (e) => {
        setEventos((atuais) => mesclarEventos(atuais, [e]));
        if (exigeRecarregarExecucao(e)) agendarRecarga();
        if (e.tipo === 'execucao.estado' && contaEmAguardandoVoce(e.dados.estado)) {
          toast(`#${e.dados.numero} ${ROTULO_ESTADO_EXECUCAO[e.dados.estado].toLowerCase()}`);
        }
      },
      aoRecarregar: () => {
        setEventos([]);
        void clienteQuery.invalidateQueries({ queryKey: ['feed', id] });
        void clienteQuery.invalidateQueries({ queryKey: ['execucao', id] });
      },
    });
    return () => assinatura.fechar();
    // O SSE abre uma vez por carga do feed; recargas posteriores recriam a assinatura.
  }, [id, feedPronto, ultimoSeqInicial, agendarRecarga, clienteQuery]);

  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(
    () => () => {
      if (recarregarRetrato.current) clearTimeout(recarregarRetrato.current);
    },
    [],
  );

  const carregarAnteriores = useCallback(async () => {
    const primeiro = eventos[0];
    if (!primeiro) return;
    try {
      const pagina = await api('execucao_feed', {
        params: { id },
        entrada: { antes_de_seq: primeiro.seq, limite: LIMITE_FEED },
      });
      setEventos((atuais) => mesclarEventos(atuais, pagina.eventos));
      setHaMaisAntigos(pagina.ha_mais_antigos);
    } catch {
      toast.error('Não foi possível carregar os eventos anteriores.');
    }
  }, [eventos, id]);

  const pausar = useComando({
    executar: () => api('execucao_pausar', { params: { id } }),
    sucesso: 'Etapa pausada: converse pela caixa abaixo.',
    invalidar: [['execucao', id]],
  });

  const ex = execucao.data;
  const etapaAtual =
    ex?.etapas.find((e) => e.estado === 'executando') ?? ex?.etapas[ex.etapas.length - 1];
  const negacoesEtapa = useMemo(
    () => (etapaAtual ? contarNegacoes(eventos, etapaAtual.id) : 0),
    [eventos, etapaAtual],
  );
  const semAtividade = semAtividadeHa(ex?.sem_atividade_desde ?? null, agora);

  if (execucao.isLoading) return <CarregandoTela />;
  if (execucao.error || !ex) {
    return <ErroTela erro={execucao.error} titulo="Não foi possível abrir a execução" />;
  }

  const encerrada = execucaoEncerrada(ex.estado);
  const colunaPlano = mostraCartaoDecisao(ex) ? (
    <CartaoDecisao execucao={ex} aoDescartar={() => setDialogo('descartar')} />
  ) : ex.plano ? (
    <div className="flex flex-col gap-3">
      {ex.estado === 'aguardando_plano' && (
        <CartaoAprovarPlano
          execucaoId={ex.id}
          plano={ex.plano}
          acoes={ex.acoes}
          aoDescartar={() => setDialogo('descartar')}
        />
      )}
      <PainelPlano plano={ex.plano} />
    </div>
  ) : (
    <PlanoCarregando />
  );

  return (
    <div className="flex min-h-full flex-col">
      <CabecalhoExecucao
        execucao={ex}
        negacoesEtapaAtual={negacoesEtapa}
        aoIrParaConversa={() => {
          conversaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          conversaRef.current?.focus();
        }}
      />
      <div className="flex flex-col gap-4 p-6">
        {encerrada && (
          <Faixa
            tom="info"
            titulo={`Execução ${ROTULO_ESTADO_EXECUCAO[ex.estado].toLowerCase()}: modo leitura`}
            acoes={
              podeApagarDados(ex.estado) && (
                <BotaoApagarDados
                  execucaoId={ex.id}
                  numero={ex.chamado.numero}
                  invalidar={[['execucao', ex.id], ['feed', ex.id], ['historico']]}
                  variante="outline"
                />
              )
            }
          >
            Nada mais roda nesta execução. O que aconteceu fica no feed e no plano abaixo.
          </Faixa>
        )}
        <CartoesEstado
          execucao={ex}
          semAtividadeMs={semAtividade}
          aoPausar={() => pausar.mutate(undefined)}
          aoParar={() => setDialogo('parar')}
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="flex min-w-0 flex-col gap-3">{colunaPlano}</div>
          <FeedAoVivo
            eventos={eventos}
            carregando={feed.isLoading}
            haMaisAntigos={haMaisAntigos}
            aoCarregarAnteriores={() => void carregarAnteriores()}
            etapas={ex.etapas}
            execucaoId={ex.id}
          />
        </div>
        {!encerrada && <ConversaChamado ref={conversaRef} execucao={ex} />}
      </div>
      <DialogoParar
        execucaoId={ex.id}
        aberto={dialogo === 'parar'}
        aoFechar={() => setDialogo(null)}
      />
      <DialogoDescartar
        execucaoId={ex.id}
        numero={ex.chamado.numero}
        aberto={dialogo === 'descartar'}
        aoFechar={() => setDialogo(null)}
      />
    </div>
  );
}
