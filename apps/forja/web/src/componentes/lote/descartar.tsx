import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Textarea } from '@/ui/textarea';
import { Caixa, Campo } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';

/**
 * Diálogo "Descartar" de uma execução (specs/forja/06 §4.2/§4.4: motivo,
 * nota interna opcional e "remover worktree e branch", padrão manter). Usado
 * nos cartões da mesa ("Descartar" / "Descartar do lote").
 */
export function DialogoDescartar({
  execucaoId,
  numero,
  aberto,
  aoMudarAberto,
  invalidar,
}: {
  execucaoId: string;
  numero: number;
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
  invalidar: readonly unknown[][];
}) {
  const [motivo, setMotivo] = useState('');
  const [nota, setNota] = useState('');
  const [remover, setRemover] = useState(false);

  useEffect(() => {
    if (!aberto) {
      setMotivo('');
      setNota('');
      setRemover(false);
    }
  }, [aberto]);

  const comando = useComando({
    executar: () =>
      api('execucao_descartar', {
        params: { id: execucaoId },
        entrada: {
          motivo: motivo.trim(),
          nota_interna: nota.trim() ? nota.trim() : null,
          remover_worktree: remover,
        },
      }),
    invalidar: [...invalidar],
    sucesso: `#${numero} descartado`,
    aoSucesso: () => aoMudarAberto(false),
  });

  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={aoMudarAberto}
      titulo={`Descartar #${numero}?`}
      descricao="A execução é encerrada. O chamado continua no Chamados como está."
      rotuloConfirmar="Descartar"
      destrutivo
      bloqueado={motivo.trim().length === 0}
      pendente={comando.isPending}
      aoConfirmar={() => comando.mutate(undefined)}
    >
      <Campo rotulo="Motivo (obrigatório)">
        {(id) => (
          <Textarea id={id} value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} />
        )}
      </Campo>
      <Campo
        rotulo="Nota interna no Chamados (opcional)"
        ajuda="Visível só para a equipe; o cliente não vê."
      >
        {(id) => (
          <Textarea id={id} value={nota} onChange={(e) => setNota(e.target.value)} rows={2} />
        )}
      </Campo>
      <Caixa
        marcada={remover}
        aoMudar={setRemover}
        rotulo="Remover worktree e branch"
        descricao="Padrão: manter, para você poder consultar depois em Histórico › Worktrees."
      />
    </DialogoConfirmacao>
  );
}
