import { useState } from 'react';
import { Link } from 'react-router';
import { MessageSquareIcon, MoreHorizontalIcon } from 'lucide-react';
import type { ExecucaoDto } from '@comum/dto';
import {
  BadgeUi,
  ComplexidadeBadge,
  EstadoExecucaoBadge,
  NaturezaBadge,
  PrioridadeBadge,
  StatusBadge,
} from '@/componentes/badges';
import { api } from '@/lib/api';
import { formatarCustoEquivalente } from '@/lib/formato';
import { ROTULO_ETAPA } from '@/lib/rotulos';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import {
  DialogoAssumir,
  DialogoDescartar,
  DialogoEncerrar,
  DialogoParar,
} from './dialogos-execucao';
import { duracaoEntre, formatarDuracao, textoCiclos } from './formato-execucao';
import { TrilhaEtapas } from './trilha-etapas';
import { useComando } from '@/componentes/apoio/comando';

/**
 * Cabeçalho da Execução (specs/forja/06 §4.2): `#N Título · branch · ciclo ·
 * custo equiv. · duração`, os badges do Chamados (status, natureza,
 * prioridade, complexidade) + estado da execução (+ `UI`), o badge "novidade
 * do cliente" quando chegou mensagem pública depois do início, a trilha e as
 * ações — cada uma só aparece se o servidor a listou em `acoes` (a regra de
 * quando cabe fica em 03-pipeline; a UI não a reinventa).
 */

export function CabecalhoExecucao({
  execucao,
  negacoesEtapaAtual,
  aoIrParaConversa,
}: {
  execucao: ExecucaoDto;
  negacoesEtapaAtual: number;
  aoIrParaConversa: () => void;
}) {
  const ex = execucao;
  const [dialogo, setDialogo] = useState<'assumir' | 'parar' | 'descartar' | 'encerrar' | null>(
    null,
  );
  const tem = (a: ExecucaoDto['acoes'][number]) => ex.acoes.includes(a);
  const invalidar = [['execucao', ex.id], ['fila']];

  const pausar = useComando({
    executar: () => api('execucao_pausar', { params: { id: ex.id } }),
    sucesso: 'Etapa pausada: converse pela caixa abaixo.',
    invalidar,
  });
  const retomar = useComando({
    executar: () => api('execucao_retomar', { params: { id: ex.id }, entrada: {} }),
    sucesso: 'Etapa retomada.',
    invalidar,
  });
  const devolver = useComando({
    executar: () => api('execucao_devolver', { params: { id: ex.id } }),
    sucesso: 'Devolvido ao pipeline: verificação e revisão em seguida.',
    invalidar,
  });
  const tentar = useComando({
    executar: () => api('execucao_tentar_novamente', { params: { id: ex.id } }),
    sucesso: 'Tentando de novo.',
    invalidar,
  });

  const etapaAtual =
    ex.etapas.find((e) => e.estado === 'executando') ?? ex.etapas[ex.etapas.length - 1];
  const sessaoId = etapaAtual?.session_id ?? null;
  const duracao = formatarDuracao(duracaoEntre(ex.iniciado_em, ex.concluido_em));
  const ciclos = textoCiclos(ex.ciclo_auto, ex.ciclo_total, ex.limites_ciclo);
  const novidades = ex.mensagens_novas_cliente.length;

  const linhaMeta = [
    ex.branch,
    ciclos,
    formatarCustoEquivalente(ex.custo_micro_usd),
    duracao,
  ].filter(Boolean);

  return (
    <header className="flex flex-col gap-3 border-b bg-card px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-muted-foreground">#{ex.chamado.numero}</span> {ex.chamado.titulo}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{linhaMeta.join(' · ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tem('abrir_aprovacao') && (
            <Button render={<Link to={`/execucoes/${ex.id}/aprovacao`} />}>Abrir aprovação</Button>
          )}
          {tem('pausar') && (
            <Button
              variant="outline"
              onClick={() => pausar.mutate(undefined)}
              disabled={pausar.isPending}
            >
              Pausar e conversar
            </Button>
          )}
          {tem('retomar') && (
            <Button
              variant="outline"
              onClick={() => retomar.mutate(undefined)}
              disabled={retomar.isPending}
            >
              Retomar etapa
            </Button>
          )}
          {tem('devolver') && (
            <Button onClick={() => devolver.mutate(undefined)} disabled={devolver.isPending}>
              Devolver ao pipeline
            </Button>
          )}
          {tem('tentar_novamente') && (
            <Button
              variant="outline"
              onClick={() => tentar.mutate(undefined)}
              disabled={tentar.isPending}
            >
              {/* FJ-036: no conflito com o destino, "tentar de novo" = o agente resolve. */}
              {ex.estado === 'precisa_humano' && ex.motivo_estado === 'conflito_merge'
                ? 'Resolver conflito com o agente'
                : 'Tentar de novo'}
            </Button>
          )}
          {tem('assumir') && (
            <Button variant="outline" onClick={() => setDialogo('assumir')}>
              Assumir no terminal
            </Button>
          )}
          {tem('parar') && (
            <Button variant="destructive" onClick={() => setDialogo('parar')}>
              Parar
            </Button>
          )}
          {(tem('descartar') || tem('encerrar')) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" aria-label="Mais ações" />}
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {tem('encerrar') && (
                  <DropdownMenuItem onClick={() => setDialogo('encerrar')}>
                    Encerrar…
                  </DropdownMenuItem>
                )}
                {tem('descartar') && (
                  <DropdownMenuItem variant="destructive" onClick={() => setDialogo('descartar')}>
                    Descartar…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={ex.chamado.status} />
        <NaturezaBadge natureza={ex.chamado.natureza} />
        <PrioridadeBadge prioridade={ex.chamado.prioridade} />
        {ex.chamado.complexidade && <ComplexidadeBadge complexidade={ex.chamado.complexidade} />}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <EstadoExecucaoBadge estado={ex.estado} />
        {ex.altera_ui && (
          <BadgeUi
            telas={ex.plano?.plano.telas_afetadas.length ?? 0}
            semPrintsMotivo={
              ex.evidencia_visual === 'parcial' || ex.evidencia_visual === 'sem_evidencia_visual'
                ? (ex.evidencia_visual_motivo ?? 'motivo não informado')
                : null
            }
          />
        )}
        {etapaAtual && (
          <span className="text-xs text-muted-foreground">
            etapa {etapaAtual.n} · {ROTULO_ETAPA[etapaAtual.tipo]}
            {negacoesEtapaAtual > 0 && (
              <span className="ml-1 font-medium text-rose-700 dark:text-rose-300">
                · {negacoesEtapaAtual} {negacoesEtapaAtual === 1 ? 'negação' : 'negações'}
              </span>
            )}
          </span>
        )}
        {novidades > 0 && (
          <button
            type="button"
            onClick={aoIrParaConversa}
            className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-sky-800/60 dark:bg-sky-950/50 dark:text-sky-300"
          >
            <MessageSquareIcon className="size-3" aria-hidden />
            novidade do cliente ({novidades})
          </button>
        )}
      </div>

      <TrilhaEtapas nos={ex.trilha} marcadorCiclos={ciclos} />

      <DialogoAssumir
        execucaoId={ex.id}
        sessaoId={sessaoId}
        aberto={dialogo === 'assumir'}
        aoFechar={() => setDialogo(null)}
      />
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
      <DialogoEncerrar
        execucaoId={ex.id}
        numero={ex.chamado.numero}
        aberto={dialogo === 'encerrar'}
        aoFechar={() => setDialogo(null)}
      />
    </header>
  );
}
