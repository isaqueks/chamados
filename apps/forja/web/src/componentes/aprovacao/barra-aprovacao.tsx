import { useState, type Ref } from 'react';
import { AlertTriangleIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AprovacaoDto, AprovarDto, PedirAjustesDto } from '@comum/dto';
import type { PoliticaStatus } from '@comum/estados';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { CaixaMarcacao, GrupoRadio, Tecla } from '@/componentes/execucao/suporte';
import { useComando } from '@/componentes/apoio/comando';
import type { AcoesAprovacao } from '@/componentes/execucao/acoes-execucao';
import type { LinhaAviso } from './regras-aprovar';

/**
 * Rodapé de decisão da Aprovação (specs/forja/06 §4.3; FJ-034, 2026-10-03 —
 * "dois cliques"): uma ação primária (Aprovar e mergear) e as secundárias
 * (Pedir ajustes `R`, Assumir `T`, Descartar — sem atalho).
 *
 * - "Aprovar e mergear" está SEMPRE habilitado quando o servidor oferece a ação
 *   e aprova num clique: sem checkboxes, sem diálogo com o patch-id. Os avisos
 *   (mensagem nova, sem prints, achados, conflito previsto, sensíveis, riscos do
 *   plano, patch curto) ficam empilhados logo acima do botão.
 * - As opções de status vêm do projeto (U-1), cada uma com a frase de
 *   consequência; o modo de entrega aparece como texto fixo.
 * - Sem feedback otimista: espera a gravação. Recusa por dado velho (409/422:
 *   patch novo, mensagem nova do cliente, sha) recarrega a aprovação.
 */

export function BarraAprovacao({
  aprovacao,
  politica,
  aoMudarPolitica,
  avisos,
  acoes,
  entrada,
  botaoAprovarRef,
  aoPedirAjustes,
  aoAssumir,
  aoDescartar,
}: {
  aprovacao: AprovacaoDto;
  politica: PoliticaStatus;
  aoMudarPolitica: (p: PoliticaStatus) => void;
  avisos: readonly LinhaAviso[];
  /** Ações oferecidas pelo servidor (`ExecucaoDto.acoes`): botão ausente = ação inválida agora. */
  acoes: AcoesAprovacao;
  entrada: AprovarDto;
  botaoAprovarRef?: Ref<HTMLButtonElement>;
  aoPedirAjustes: () => void;
  aoAssumir: () => void;
  aoDescartar: () => void;
}) {
  const a = aprovacao;
  const navegar = useNavigate();
  const clienteQuery = useQueryClient();
  const aprovar = useComando({
    executar: () => api('aprovacao_aprovar', { params: { id: a.execucao_id }, entrada }),
    sucesso: `#${a.chamado.numero} aprovado: entrou na fila de merge.`,
    invalidar: [['aprovacao', a.execucao_id], ['execucao', a.execucao_id], ['fila'], ['shell']],
    aoSucesso: () => navegar('/merge'),
    // Recusa por dado velho (patch novo, mensagem nova do cliente, sha): recarrega a
    // aprovação, que mostra os avisos novos.
    aoErro: (erro) => {
      const status = (erro as { status?: number } | null)?.status;
      if (status === 409 || status === 422) {
        void clienteQuery.invalidateQueries({ queryKey: ['aprovacao', a.execucao_id] });
        void clienteQuery.invalidateQueries({ queryKey: ['execucao', a.execucao_id] });
      }
    },
  });
  const alertas = avisos.filter((x) => !x.informativo);
  const informativos = avisos.filter((x) => x.informativo);
  return (
    <footer className="sticky bottom-0 z-10 flex flex-col gap-3 border-t bg-card px-6 py-4 shadow-flutuante">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Ao concluir</span>
        <GrupoRadio
          rotuloAcessivel="Status do chamado ao concluir"
          valor={politica}
          aoMudar={aoMudarPolitica}
          className="sm:flex-row sm:flex-wrap sm:gap-x-6"
          opcoes={a.opcoes_status.map((o) => ({
            valor: o.valor,
            rotulo: o.rotulo,
            descricao: o.consequencia,
            desabilitada: !o.habilitada,
          }))}
        />
        <p className="text-xs text-muted-foreground">Entrega: {a.descricao_entrega}</p>
      </div>
      {acoes.aprovar && alertas.length > 0 && (
        <ul
          aria-label="Avisos antes de aprovar"
          className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
        >
          {alertas.map((x, i) => (
            <li key={`${x.tipo}-${i}`} className="flex items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{x.mensagem}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {acoes.aprovar && (
          <Button
            ref={botaoAprovarRef}
            onClick={() => aprovar.mutate(undefined)}
            disabled={aprovar.isPending}
          >
            {aprovar.isPending ? 'Aprovando…' : 'Aprovar e mergear'} <Tecla>A</Tecla>
          </Button>
        )}
        {acoes.pedirAjustes && (
          <Button variant="outline" onClick={aoPedirAjustes}>
            Pedir ajustes <Tecla>R</Tecla>
          </Button>
        )}
        {acoes.assumir && (
          <Button variant="outline" onClick={aoAssumir}>
            Assumir <Tecla>T</Tecla>
          </Button>
        )}
        {acoes.descartar && (
          <Button variant="ghost" onClick={aoDescartar}>
            Descartar
          </Button>
        )}
        {acoes.aprovar && informativos.length > 0 && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {informativos.map((x) => x.mensagem).join(' · ')} → {a.branch_destino}
          </span>
        )}
      </div>
    </footer>
  );
}

export function DialogoPedirAjustes({
  execucaoId,
  aberto,
  aoFechar,
  arquivos,
  tetoCiclos,
}: {
  execucaoId: string;
  aberto: boolean;
  aoFechar: () => void;
  arquivos: string[];
  tetoCiclos: string | null;
}) {
  const navegar = useNavigate();
  const [comentario, setComentario] = useState('');
  const [citados, setCitados] = useState<Set<string>>(new Set());
  const pedir = useComando({
    executar: (entrada: PedirAjustesDto) =>
      api('aprovacao_pedir_ajustes', { params: { id: execucaoId }, entrada }),
    sucesso: 'Ajustes pedidos: novo ciclo de implementação.',
    invalidar: [['aprovacao', execucaoId], ['execucao', execucaoId], ['fila']],
    aoSucesso: () => {
      aoFechar();
      navegar(`/execucoes/${execucaoId}`);
    },
  });
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo="Pedir ajustes"
      descricao={`Volta para o condutor com o seu comentário.${tetoCiclos ? ` Este ciclo conta para o teto total (${tetoCiclos}).` : ''}`}
      rotuloConfirmar="Pedir ajustes"
      bloqueado={comentario.trim().length === 0}
      pendente={pedir.isPending}
      aoConfirmar={() =>
        pedir.mutate({
          comentario: comentario.trim(),
          arquivos: citados.size ? [...citados] : undefined,
        })
      }
      largo
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="comentario-ajustes">Comentário geral (obrigatório)</Label>
          <Textarea
            id="comentario-ajustes"
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            placeholder="ex.: aceitar +tag; não validar na importação"
            className="min-h-28"
          />
        </div>
        {arquivos.length > 0 && (
          <fieldset className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
            <legend className="mb-1 text-sm font-medium">Citar arquivos (opcional)</legend>
            {arquivos.map((c) => (
              <CaixaMarcacao
                key={c}
                marcado={citados.has(c)}
                aoMudar={(v) => {
                  const novo = new Set(citados);
                  if (v) novo.add(c);
                  else novo.delete(c);
                  setCitados(novo);
                }}
                rotulo={<span className="font-mono text-xs">{c}</span>}
              />
            ))}
          </fieldset>
        )}
        <p className="text-xs text-muted-foreground">
          Comentário por linha no diff fica para a Fase 2.
        </p>
      </div>
    </DialogoConfirmacao>
  );
}
