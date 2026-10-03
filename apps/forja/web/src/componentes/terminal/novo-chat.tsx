import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Campo, CampoSelect } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';

/**
 * "Novo chat" do Terminal (specs/forja/06 §4.7): `claude` interativo com cwd
 * no repositório do projeto ou numa worktree escolhida. É o "Claude normal"
 * do usuário (settings e MCPs dele), fora do pipeline (F-13) — o diálogo diz
 * isso para não parecer que a sessão entra numa execução.
 */
export function DialogoNovoChat({
  aberto,
  aoMudarAberto,
  projetoInicial,
  aoAbrir,
}: {
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
  projetoInicial: string | null;
  aoAbrir: (sessaoId: string) => void;
}) {
  const [projetoId, setProjetoId] = useState<string | null>(projetoInicial);
  const [alvo, setAlvo] = useState<string>('repo');

  const projetos = useQuery({
    queryKey: ['projetos'],
    queryFn: ({ signal }) => api('projetos_listar', { sinal: signal }),
    enabled: aberto,
  });
  const worktrees = useQuery({
    queryKey: ['worktrees'],
    queryFn: ({ signal }) => api('worktrees_listar', { sinal: signal }),
    enabled: aberto,
  });

  useEffect(() => {
    if (!aberto) return;
    setAlvo('repo');
    setProjetoId((atual) => atual ?? projetoInicial);
  }, [aberto, projetoInicial]);

  useEffect(() => {
    const lista = projetos.data?.projetos ?? [];
    if (!projetoId && lista.length > 0) setProjetoId(lista[0]?.id ?? null);
  }, [projetos.data, projetoId]);

  const opcoesWorktree = (worktrees.data?.worktrees ?? []).filter(
    (w) => w.execucao_id && (!w.projeto_id || w.projeto_id === projetoId),
  );

  const abrir = useComando({
    executar: () =>
      api('terminal_abrir', {
        entrada: {
          projeto_id: projetoId ?? '',
          ...(alvo !== 'repo' ? { execucao_id: alvo } : {}),
        },
      }),
    invalidar: [['terminal']],
    aoSucesso: (r) => {
      aoMudarAberto(false);
      aoAbrir(r.sessao_id);
    },
  });

  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={aoMudarAberto}
      titulo="Novo chat com o Claude"
      descricao="Abre o claude interativo, com as suas configurações e MCPs, fora do pipeline. Nada do que acontecer aqui entra numa execução."
      rotuloConfirmar="Abrir chat"
      bloqueado={!projetoId}
      pendente={abrir.isPending}
      aoConfirmar={() => abrir.mutate(undefined)}
    >
      <Campo rotulo="Projeto">
        {(id) => (
          <CampoSelect
            id={id}
            valor={projetoId}
            placeholder={projetos.isPending ? 'Carregando…' : 'Escolha o projeto'}
            opcoes={(projetos.data?.projetos ?? []).map((p) => ({ valor: p.id, rotulo: p.nome }))}
            aoMudar={(v) => {
              setProjetoId(v);
              setAlvo('repo');
            }}
          />
        )}
      </Campo>
      <Campo
        rotulo="Diretório"
        ajuda="Na sua cópia do repositório, ou na worktree de uma execução."
      >
        {(id) => (
          <CampoSelect
            id={id}
            valor={alvo}
            opcoes={[
              { valor: 'repo', rotulo: 'Repositório do projeto' },
              ...opcoesWorktree.map((w) => ({
                valor: w.execucao_id as string,
                rotulo: `Worktree #${w.numero ?? '?'} · ${w.branch ?? w.caminho}`,
              })),
            ]}
            aoMudar={setAlvo}
          />
        )}
      </Campo>
    </DialogoConfirmacao>
  );
}
