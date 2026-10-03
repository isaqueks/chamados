import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
} from '@/componentes/apoio/estrutura-tela';
import { FormularioProjeto } from '@/componentes/projeto/formulario-projeto';

/**
 * Projeto (specs/forja/06 §4.8, reduzido pela FJ-030 §5): nome, pasta, branch,
 * sistemas-alvo, o "Detectado" somente leitura e o "Avançado" em JSON. Nada
 * mais — modelos, cota, limites e gates foram para Configurações (global); as
 * evidências visuais são do agente (nota §3), sem login gravado nem captura de
 * teste. Rota `/projetos/novo` cria; `/projetos/:id` edita. Execuções já
 * iniciadas usam o `config_snapshot` delas (02 §4.2).
 */
export function TelaProjeto() {
  const { id = '' } = useParams();
  const navegar = useNavigate();
  const novo = id === 'novo';
  const projeto = useQuery({
    queryKey: ['projeto', id],
    queryFn: ({ signal }) => api('projeto_obter', { params: { id }, sinal: signal }),
    enabled: !novo,
  });
  const conexoes = useQuery({
    queryKey: ['conexoes'],
    queryFn: ({ signal }) => api('conexoes_listar', { sinal: signal }),
    enabled: novo,
  });

  const titulo = novo ? 'Novo projeto' : (projeto.data?.nome ?? 'Projeto');
  return (
    <Pagina>
      <CabecalhoPagina
        voltar={{ href: '/projetos', rotulo: 'Projetos' }}
        titulo={titulo}
        descricao="Aponte a pasta do repositório: o resto é detectado. Ajustes finos ficam no Avançado."
      />
      {(!novo && projeto.isPending) || (novo && conexoes.isPending) ? (
        <Carregando linhas={4} />
      ) : !novo && projeto.isError ? (
        <ErroCarregar erro={projeto.error} tentarDeNovo={() => void projeto.refetch()} />
      ) : novo && conexoes.isError ? (
        <ErroCarregar erro={conexoes.error} tentarDeNovo={() => void conexoes.refetch()} />
      ) : (
        <FormularioProjeto
          projeto={novo ? null : (projeto.data ?? null)}
          conexaoId={conexoes.data?.conexoes[0]?.id ?? null}
          aoSalvo={(novoId) => {
            if (novo) navegar(`/projetos/${novoId}`, { replace: true });
          }}
        />
      )}
    </Pagina>
  );
}
