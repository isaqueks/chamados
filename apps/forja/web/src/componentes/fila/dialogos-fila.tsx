import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { LinhaFilaDto } from '@comum/dto';
import { api } from '@/lib/api';
import { Skeleton } from '@/ui/skeleton';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { CaixaMarcacao, Faixa } from '@/componentes/execucao/suporte';
import { useComando } from '@/componentes/apoio/comando';
import { mensagemErro } from '@/componentes/apoio/texto';
import { exigeConfirmacaoAguardandoCliente } from './logica-fila';

/**
 * Diálogos da Fila (specs/forja/06 §4.1 "Ações", §5.1, §5.2):
 *
 * - **Implementar** com confirmação quando o chamado está `aguardando_cliente`
 *   ("o cliente ainda não respondeu; implementar mesmo assim?") e/ou tem
 *   `PR IA ⚠` (no MVP só "ignorar a branch da IA", registrado na execução).
 *   Sem nada a confirmar, a tela chama `execucao_criar` direto.
 * - **Implementar em lote (N)**: a prévia do servidor lista os incluídos, os
 *   excluídos por pré-condição (com o motivo), a nota de que tudo segue direto
 *   até a aprovação (FJ-034) e a concorrência; confirmar cria o lote e abre o
 *   acompanhamento do lote (a mesa de planos só aparece se algum plano parar).
 */

export function precisaDialogoImplementar(linha: LinhaFilaDto): boolean {
  return exigeConfirmacaoAguardandoCliente(linha) || linha.sinais.tem_pr_ia;
}

export function useImplementar(projetoId: string | null) {
  const navegar = useNavigate();
  return useComando({
    executar: (entrada: { linha: LinhaFilaDto; ignorarPrIa: boolean }) =>
      api('execucao_criar', {
        entrada: {
          projeto_id: projetoId ?? '',
          chamado_id: entrada.linha.chamado.chamado_id,
          confirmar_aguardando_cliente:
            exigeConfirmacaoAguardandoCliente(entrada.linha) || undefined,
          ignorar_pr_ia: entrada.ignorarPrIa || undefined,
        },
      }),
    invalidar: [['fila'], ['shell']],
    aoSucesso: (r) => navegar(`/execucoes/${r.execucao_id}`),
  });
}

export function DialogoImplementar({
  linha,
  aoFechar,
  aoConfirmar,
  pendente,
}: {
  linha: LinhaFilaDto | null;
  aoFechar: () => void;
  aoConfirmar: (ignorarPrIa: boolean) => void;
  pendente: boolean;
}) {
  const [ignorar, setIgnorar] = useState(false);
  const aguardando = linha ? exigeConfirmacaoAguardandoCliente(linha) : false;
  const prIa = linha?.sinais.tem_pr_ia ?? false;
  return (
    <DialogoConfirmacao
      aberto={linha !== null}
      aoMudarAberto={(v) => {
        if (v) return;
        setIgnorar(false);
        aoFechar();
      }}
      titulo={linha ? `Implementar #${linha.chamado.numero}?` : ''}
      rotuloConfirmar="Implementar"
      bloqueado={prIa && !ignorar}
      pendente={pendente}
      aoConfirmar={() => aoConfirmar(ignorar)}
    >
      <div className="flex flex-col gap-3 text-sm">
        {aguardando && <p>O cliente ainda não respondeu. Implementar mesmo assim?</p>}
        {prIa && (
          <Faixa tom="aviso" titulo="A IA do servidor já tem uma branch para este chamado">
            <span className="font-mono text-xs">{linha?.sinais.branch_ia ?? '—'}</span>
            <CaixaMarcacao
              marcado={ignorar}
              aoMudar={setIgnorar}
              rotulo="Ignorar a branch da IA e partir do destino (fica registrado na execução)"
            />
          </Faixa>
        )}
      </div>
    </DialogoConfirmacao>
  );
}

export function DialogoLote({
  aberto,
  aoFechar,
  projetoId,
  chamadoIds,
}: {
  aberto: boolean;
  aoFechar: () => void;
  projetoId: string | null;
  chamadoIds: string[];
}) {
  const navegar = useNavigate();
  const entrada = { projeto_id: projetoId ?? '', chamado_ids: chamadoIds };
  const previa = useQuery({
    queryKey: ['lote_previa', projetoId, chamadoIds],
    queryFn: ({ signal }) => api('lote_previa', { entrada, sinal: signal }),
    enabled: aberto && !!projetoId && chamadoIds.length > 0,
    staleTime: 0,
  });
  const criar = useComando({
    executar: () => api('lote_criar', { entrada }),
    invalidar: [['fila'], ['shell']],
    aoSucesso: (r) => {
      aoFechar();
      // FJ-034: sem mesa obrigatória — abre o acompanhamento do lote.
      navegar(`/lotes/${r.lote_id}`);
    },
  });
  const p = previa.data;
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo={`Implementar em lote (${chamadoIds.length})`}
      descricao="Cada chamado é planejado e implementado direto; você aprova um por um em Aguardando você. A mesa de planos só aparece se algum plano parar."
      rotuloConfirmar={p ? `Criar lote com ${p.incluidos.length}` : 'Criar lote'}
      bloqueado={!p || p.incluidos.length === 0}
      pendente={criar.isPending}
      aoConfirmar={() => criar.mutate(undefined)}
      largo
    >
      {previa.error ? (
        <Faixa tom="erro" titulo="Não foi possível montar a prévia do lote">
          {mensagemErro(previa.error)}
        </Faixa>
      ) : !p ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <section>
            <h4 className="mb-1 font-medium">Entram ({p.incluidos.length})</h4>
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {p.incluidos.map((c) => (
                <li key={c.chamado_id}>
                  <span className="font-mono text-muted-foreground">#{c.numero}</span> {c.titulo}
                </li>
              ))}
            </ul>
          </section>
          {p.excluidos.length > 0 && (
            <section>
              <h4 className="mb-1 font-medium">Ficam de fora ({p.excluidos.length})</h4>
              <ul className="flex flex-col gap-0.5">
                {p.excluidos.map((x) => (
                  <li key={x.chamado.chamado_id}>
                    <span className="font-mono text-muted-foreground">#{x.chamado.numero}</span>{' '}
                    {x.chamado.titulo}{' '}
                    <span className="text-muted-foreground">— {x.motivos.join('; ')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-xs text-muted-foreground">
            Concorrência atual: {p.concorrencia_planos} planos e {p.concorrencia_impl}{' '}
            implementações em paralelo.
          </p>
        </div>
      )}
    </DialogoConfirmacao>
  );
}
