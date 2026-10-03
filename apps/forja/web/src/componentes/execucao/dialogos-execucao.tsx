import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { CaixaMarcacao } from './suporte';
import { useComando } from '@/componentes/apoio/comando';

/**
 * Diálogos das ações da Execução e da Aprovação (specs/forja/06 §4.2 tabela
 * "Ações", §4.3 "Assumir"/"Descartar", §5.6). Regra comum (06 §6 princípio 5 e
 * §9): o irreversível se confirma com o que será feito; foco inicial em
 * **Cancelar**; `Ctrl+Enter` confirma, `Esc` cancela; sem feedback otimista —
 * tudo isso é o `DialogoConfirmacao` comum (componentes/apoio/confirmar).
 */

const chaves = (id: string) => [['execucao', id], ['aprovacao', id], ['fila']];

/** "Assumir no terminal" (06 §5.6). Ao confirmar, abre a aba do Terminal. */
export function DialogoAssumir({
  execucaoId,
  sessaoId,
  aberto,
  aoFechar,
  invalidaAprovacao = false,
}: {
  execucaoId: string;
  sessaoId: string | null;
  aberto: boolean;
  aoFechar: () => void;
  invalidaAprovacao?: boolean;
}) {
  const navegar = useNavigate();
  const assumir = useComando({
    executar: () => api('execucao_assumir', { params: { id: execucaoId } }),
    invalidar: chaves(execucaoId),
    aoSucesso: (r) => {
      aoFechar();
      navegar(`/terminal?sessao=${encodeURIComponent(r.sessao_terminal_id)}`);
    },
  });
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo="Assumir no terminal"
      rotuloConfirmar="Assumir"
      pendente={assumir.isPending}
      aoConfirmar={() => assumir.mutate(undefined)}
    >
      <div className="flex flex-col gap-2 text-sm">
        <p>
          A etapa atual pausa (SIGINT). A sessão{' '}
          {sessaoId && <code className="font-mono text-xs">{sessaoId.slice(0, 8)}…</code>} abre no
          Terminal com as regras deny da etapa; as permissões são pedidas a você na própria TUI (sem
          bypass).
        </p>
        <p>Ninguém mais escreve nesta sessão até você devolver ao pipeline.</p>
        {invalidaAprovacao && (
          <p className="font-medium">
            Ao devolver, esta aprovação deixa de valer: o patch muda e passa por verificação e
            revisão de novo.
          </p>
        )}
      </div>
    </DialogoConfirmacao>
  );
}

/** "Parar": escada de sinais no grupo de processos → `pausado_usuario`. */
export function DialogoParar({
  execucaoId,
  aberto,
  aoFechar,
}: {
  execucaoId: string;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const parar = useComando({
    executar: () => api('execucao_parar', { params: { id: execucaoId } }),
    sucesso: 'Execução parada.',
    invalidar: chaves(execucaoId),
    aoSucesso: aoFechar,
  });
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo="Parar a etapa?"
      descricao="Os processos da etapa recebem SIGINT, depois SIGTERM. A execução fica pausada, com [Retomar] e [Descartar]."
      rotuloConfirmar="Parar"
      destrutivo
      pendente={parar.isPending}
      aoConfirmar={() => parar.mutate(undefined)}
    />
  );
}

/** "Descartar": motivo, nota interna opcional e manter/remover a worktree (padrão: manter). */
export function DialogoDescartar({
  execucaoId,
  numero,
  aberto,
  aoFechar,
}: {
  execucaoId: string;
  numero: number;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [nota, setNota] = useState('');
  const [remover, setRemover] = useState(false);
  const descartar = useComando({
    executar: () =>
      api('execucao_descartar', {
        params: { id: execucaoId },
        entrada: {
          motivo: motivo.trim(),
          nota_interna: nota.trim() || null,
          remover_worktree: remover,
        },
      }),
    sucesso: `#${numero} descartado.`,
    invalidar: chaves(execucaoId),
    aoSucesso: aoFechar,
  });
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo={`Descartar #${numero}?`}
      descricao="A execução é encerrada. Nada é publicado ao cliente."
      rotuloConfirmar="Descartar"
      destrutivo
      bloqueado={motivo.trim().length === 0}
      pendente={descartar.isPending}
      aoConfirmar={() => descartar.mutate(undefined)}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="motivo-descarte">Motivo (obrigatório)</Label>
          <Textarea
            id="motivo-descarte"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="nota-descarte">Nota interna no Chamados (opcional)</Label>
          <Textarea id="nota-descarte" value={nota} onChange={(e) => setNota(e.target.value)} />
        </div>
        <CaixaMarcacao
          marcado={remover}
          aoMudar={setRemover}
          rotulo="Remover a worktree e a branch local (padrão: manter)"
        />
      </div>
    </DialogoConfirmacao>
  );
}

/** "Encerrar" (precisa de você): encerra sem descartar o registro, com motivo. */
export function DialogoEncerrar({
  execucaoId,
  numero,
  aberto,
  aoFechar,
}: {
  execucaoId: string;
  numero: number;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const encerrar = useComando({
    executar: () =>
      api('execucao_encerrar', { params: { id: execucaoId }, entrada: { motivo: motivo.trim() } }),
    sucesso: `#${numero} encerrado.`,
    invalidar: chaves(execucaoId),
    aoSucesso: aoFechar,
  });
  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={(v) => !v && aoFechar()}
      titulo={`Encerrar #${numero}?`}
      rotuloConfirmar="Encerrar"
      destrutivo
      bloqueado={motivo.trim().length === 0}
      pendente={encerrar.isPending}
      aoConfirmar={() => encerrar.mutate(undefined)}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="motivo-encerrar">Motivo (obrigatório)</Label>
        <Textarea id="motivo-encerrar" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </div>
    </DialogoConfirmacao>
  );
}
