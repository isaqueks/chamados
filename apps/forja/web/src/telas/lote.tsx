import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { GaugeIcon, LayersIcon, PauseIcon } from 'lucide-react';
import type { LinhaLoteDto } from '@comum/dto';
import { api } from '@/lib/api';
import { formatarCustoEquivalente, formatarPercentual, horaLocal } from '@/lib/formato';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { BadgeUi, EstadoExecucaoBadge } from '@/componentes/badges';
import { Caixa } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Faixa,
  Pagina,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { plural } from '@/componentes/apoio/texto';
import {
  loteAtivo,
  naMesaDePlanos,
  pendentesCancelaveis,
  ROTULO_ESTADO_LOTE,
} from '@/componentes/lote/logica';
import { MiniTrilha } from '@/componentes/lote/mini-trilha';

/**
 * Lote (specs/forja/06 §4.5, fluxo §5.2). Cada linha é uma execução própria
 * (F-14) com mini-trilha, estado, custo e a ação contextual. NÃO existe
 * aprovação final em bloco (F-11): "aprovação: 1 a 1" fica escrito no rodapé.
 * FJ-034: o lote vai direto até a aprovação; "Mesa de planos (N)" só aparece
 * quando algum plano parou (alerta de segurança, `por_risco`/`sempre`, Gdec).
 *
 * "Cancelar pendentes…" lista só o que ainda não começou a implementar e
 * preserva o que está em voo; "Pausar lote" impede novas etapas sem matar as
 * que estão rodando.
 */

function LinhaLote({ linha }: { linha: LinhaLoteDto }) {
  const e = linha.execucao;
  const acao = linha.acao ?? { rotulo: 'Abrir', href: `/execucoes/${e.id}` };
  const encerrada = e.grupo === 'encerrado';
  return (
    <li
      className={cn(
        'grid grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto_auto]',
        encerrada && 'opacity-70',
      )}
    >
      <Link
        to={`/execucoes/${e.id}`}
        className="truncate text-sm font-medium hover:underline"
        title={linha.chamado.titulo}
      >
        <span className="tabular-nums">#{linha.chamado.numero}</span> {linha.chamado.titulo}
      </Link>
      <div className="flex min-w-0 flex-col gap-0.5">
        {linha.observacao ? (
          <span className="text-xs text-muted-foreground">{linha.observacao}</span>
        ) : null}
        {!encerrada && <MiniTrilha nos={linha.mini_trilha} />}
      </div>
      <div className="flex items-center gap-1.5">
        <EstadoExecucaoBadge estado={e.estado} />
        {e.altera_ui && (
          <BadgeUi
            telas={Math.max(1, e.telas_ui ?? 1)}
            semPrintsMotivo={
              e.evidencia_visual === 'sem_evidencia_visual' || e.evidencia_visual === 'parcial'
                ? 'veja a aba Evidências'
                : null
            }
          />
        )}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums md:text-right">
        {e.custo_micro_usd > 0 ? formatarCustoEquivalente(e.custo_micro_usd) : '—'}
      </span>
      {encerrada ? (
        <span />
      ) : (
        <Link
          to={acao.href}
          className={buttonVariants({
            variant: e.grupo === 'aguardando_voce' ? 'default' : 'outline',
            size: 'sm',
          })}
        >
          {acao.rotulo}
        </Link>
      )}
    </li>
  );
}

export function TelaLote() {
  const { id = '' } = useParams();
  const chave = ['lote', id];
  const [confirmarPausa, setConfirmarPausa] = useState(false);
  const [cancelar, setCancelar] = useState(false);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());

  const consulta = useQuery({
    queryKey: chave,
    queryFn: ({ signal }) => api('lote_obter', { params: { id }, sinal: signal }),
    refetchInterval: 8_000,
  });
  const dto = consulta.data;
  const pendentes = dto ? pendentesCancelaveis(dto.linhas) : [];

  const pausar = useComando({
    executar: () => api('lote_pausar', { params: { id } }),
    invalidar: [chave, ['lotes']],
    sucesso: 'Lote pausado: nenhuma etapa nova começa',
    aoSucesso: () => setConfirmarPausa(false),
  });
  const cancelarPendentes = useComando({
    executar: () =>
      api('lote_cancelar_pendentes', {
        params: { id },
        entrada: { execucao_ids: [...marcados] },
      }),
    invalidar: [chave, ['lotes'], ['lote', id, 'planos']],
    sucesso: () => `${plural(marcados.size, 'execução cancelada', 'execuções canceladas')}`,
    aoSucesso: () => setCancelar(false),
  });

  if (consulta.isPending) {
    return (
      <Pagina largura="larga">
        <CabecalhoPagina titulo="Lote" voltar={{ href: '/lotes', rotulo: 'Lotes' }} />
        <Carregando linhas={5} />
      </Pagina>
    );
  }
  if (consulta.isError || !dto) {
    return (
      <Pagina largura="larga">
        <CabecalhoPagina titulo="Lote" voltar={{ href: '/lotes', rotulo: 'Lotes' }} />
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      </Pagina>
    );
  }

  const { lote } = dto;
  const ativo = loteAtivo(lote.estado);
  // FJ-034: sem mesa obrigatória; o link só aparece se algum plano parou.
  const naMesa = naMesaDePlanos(dto.linhas);
  const partes = [
    `iniciado ${horaLocal(lote.criado_em) ?? '—'}`,
    `implementação ${lote.concorrencia_impl} em paralelo`,
    dto.schema_em_voo
      ? `1 de schema em voo (#${dto.schema_em_voo.numero})`
      : 'nenhum de schema em voo',
    ROTULO_ESTADO_LOTE[lote.estado],
  ];

  return (
    <Pagina largura="larga">
      <CabecalhoPagina
        voltar={{ href: '/lotes', rotulo: 'Lotes' }}
        titulo={lote.nome}
        descricao={partes.join(' · ')}
        acoes={
          ativo && (
            <>
              {naMesa > 0 && (
                <Link
                  to={`/lotes/${id}/planos`}
                  className={buttonVariants({ variant: 'outline', size: 'default' })}
                >
                  Mesa de planos ({naMesa})
                </Link>
              )}
              <Button variant="outline" onClick={() => setConfirmarPausa(true)}>
                <PauseIcon aria-hidden />
                Pausar lote
              </Button>
              <Button
                variant="ghost"
                disabled={pendentes.length === 0}
                onClick={() => {
                  setMarcados(new Set(pendentes.map((l) => l.execucao.id)));
                  setCancelar(true);
                }}
              >
                Cancelar pendentes…
              </Button>
            </>
          )
        }
        extra={
          dto.projecao_5h && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GaugeIcon className="size-3.5" aria-hidden />
              cota 5h {formatarPercentual(dto.projecao_5h.atual)} → ~
              {formatarPercentual(dto.projecao_5h.estimada)} ao fim do lote (freio{' '}
              {formatarPercentual(dto.projecao_5h.limiar)})
            </p>
          )
        }
      />

      {dto.freio.ativo && (
        <Faixa nivel="aviso" icone={GaugeIcon}>
          Freio de cota: novas etapas pausadas
          {dto.freio.ate ? ` até ${horaLocal(dto.freio.ate)}` : ''}
          {dto.freio.motivo ? ` (${dto.freio.motivo})` : ''}. As etapas em curso terminam
          normalmente.
        </Faixa>
      )}

      {dto.linhas.length === 0 ? (
        <Vazio icone={LayersIcon} titulo="Este lote não tem execuções." />
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {dto.linhas.map((l) => (
              <LinhaLote key={l.execucao.id} linha={l} />
            ))}
          </ul>
        </Card>
      )}

      <p className="text-right text-xs text-muted-foreground">
        aprovação: 1 a 1 (não existe aprovação final em bloco)
      </p>

      <DialogoConfirmacao
        aberto={confirmarPausa}
        aoMudarAberto={setConfirmarPausa}
        titulo={`Pausar ${lote.nome}?`}
        descricao="Nenhuma etapa nova começa neste lote. As que estão rodando terminam normalmente; cada execução pode ser retomada na própria tela."
        rotuloConfirmar="Pausar lote"
        pendente={pausar.isPending}
        aoConfirmar={() => pausar.mutate(undefined)}
      />

      <DialogoConfirmacao
        aberto={cancelar}
        aoMudarAberto={setCancelar}
        titulo="Cancelar execuções pendentes?"
        descricao="Só o que ainda não começou a implementar. O que já está em voo continua."
        rotuloConfirmar={`Cancelar ${marcados.size}`}
        destrutivo
        bloqueado={marcados.size === 0}
        pendente={cancelarPendentes.isPending}
        aoConfirmar={() => cancelarPendentes.mutate(undefined)}
      >
        <ul className="flex flex-col gap-2">
          {pendentes.map((l) => (
            <li key={l.execucao.id} className="flex items-center justify-between gap-2">
              <Caixa
                marcada={marcados.has(l.execucao.id)}
                aoMudar={(m) =>
                  setMarcados((s) => {
                    const n = new Set(s);
                    if (m) n.add(l.execucao.id);
                    else n.delete(l.execucao.id);
                    return n;
                  })
                }
                rotulo={`#${l.chamado.numero} ${l.chamado.titulo}`}
              />
              <EstadoExecucaoBadge estado={l.execucao.estado} />
            </li>
          ))}
        </ul>
      </DialogoConfirmacao>
    </Pagina>
  );
}
