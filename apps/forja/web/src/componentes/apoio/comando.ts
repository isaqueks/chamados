import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { mensagemErro } from './texto';

/**
 * Comandos (POST/PUT) de TODAS as telas (o único `useComando` da SPA, D-009): um `useMutation` que, ao concluir,
 * invalida as consultas afetadas e avisa por toast; o erro fica no toast até
 * ser fechado (06 §8: "os de erro ficam até serem fechados").
 *
 * Sem feedback otimista (06 §6 item 5): a tela só muda quando a consulta
 * invalidada volta do servidor — o estado novo também chega pelo SSE.
 */
export function useComando<TEntrada, TSaida>(opcoes: {
  executar: (entrada: TEntrada) => Promise<TSaida>;
  invalidar?: QueryKey[];
  sucesso?: string | ((saida: TSaida, entrada: TEntrada) => string | null);
  aoSucesso?: (saida: TSaida, entrada: TEntrada) => void;
  /** Além do toast: ex.: recarregar a tela quando o servidor recusa por dado velho (409/422). */
  aoErro?: (erro: unknown, entrada: TEntrada) => void;
}) {
  const cliente = useQueryClient();
  return useMutation<TSaida, unknown, TEntrada>({
    mutationFn: opcoes.executar,
    onSuccess: async (saida, entrada) => {
      await Promise.all(
        (opcoes.invalidar ?? []).map((chave) => cliente.invalidateQueries({ queryKey: chave })),
      );
      void cliente.invalidateQueries({ queryKey: ['shell'] });
      const texto =
        typeof opcoes.sucesso === 'function' ? opcoes.sucesso(saida, entrada) : opcoes.sucesso;
      if (texto) toast.success(texto);
      opcoes.aoSucesso?.(saida, entrada);
    },
    onError: (erro, entrada) => {
      toast.error(mensagemErro(erro), { duration: Infinity });
      opcoes.aoErro?.(erro, entrada);
    },
  });
}
