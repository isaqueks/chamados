import { useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { DADOS_APAGADOS, DADOS_MANTIDOS } from './logica';

/**
 * "Apagar dados deste chamado…" (specs/forja/06 §4.11, 05 §11): remove o que
 * veio do cliente e o que foi produzido a partir disso (entrada, prints,
 * eventos, transcripts da CLI, worktree) e mantém só o registro mínimo. É
 * irreversível: a confirmação lista o que sai e exige digitar o número do
 * chamado (o servidor confere de novo, `ApagarDadosDto.confirmar_numero`).
 *
 * Exportado para a tela de Execução em modo somente leitura também montar.
 */
export function BotaoApagarDados({
  execucaoId,
  numero,
  invalidar,
  variante = 'ghost',
}: {
  execucaoId: string;
  numero: number;
  invalidar: unknown[][];
  variante?: 'ghost' | 'outline';
}) {
  const [aberto, setAberto] = useState(false);
  const comando = useComando({
    executar: () =>
      api('execucao_apagar_dados', {
        params: { id: execucaoId },
        entrada: { confirmar_numero: numero },
      }),
    invalidar,
    sucesso: (r) =>
      r.apagados.length
        ? `#${numero}: apagado ${r.apagados.join(', ')}`
        : `#${numero}: nada a apagar`,
    aoSucesso: () => setAberto(false),
  });
  return (
    <>
      <Button variant={variante} size="sm" onClick={() => setAberto(true)}>
        <Trash2Icon aria-hidden />
        Apagar dados…
      </Button>
      <DialogoConfirmacao
        aberto={aberto}
        aoMudarAberto={setAberto}
        titulo={`Apagar os dados do #${numero}?`}
        descricao="Não dá para desfazer. Os prints e o texto do cliente deixam de existir nesta máquina."
        rotuloConfirmar="Apagar dados"
        destrutivo
        digitar={{ esperado: String(numero), rotulo: `Digite ${numero} para confirmar` }}
        pendente={comando.isPending}
        aoConfirmar={() => comando.mutate(undefined)}
      >
        <ul className="list-disc pl-5">
          {DADOS_APAGADOS.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <p className="text-muted-foreground">{DADOS_MANTIDOS}</p>
      </DialogoConfirmacao>
    </>
  );
}
