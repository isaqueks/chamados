import { createBrowserRouter, Navigate } from 'react-router';
import { Layout } from '@/componentes/shell/layout';
import { TelaAprovacao } from '@/telas/aprovacao';
import { TelaConexao } from '@/telas/conexao';
import { TelaConfiguracoes } from '@/telas/configuracoes';
import { TelaDiagnostico } from '@/telas/diagnostico';
import { TelaExecucao } from '@/telas/execucao';
import { TelaFila } from '@/telas/fila';
import { TelaFilaMerge } from '@/telas/fila-merge';
import { TelaHistorico } from '@/telas/historico';
import { TelaLote } from '@/telas/lote';
import { TelaLotes } from '@/telas/lotes';
import { TelaMesaPlanos } from '@/telas/mesa-planos';
import { TelaNaoEncontrada } from '@/telas/nao-encontrada';
import { TelaOnboarding } from '@/telas/onboarding';
import { TelaProjeto } from '@/telas/projeto';
import { TelaProjetos } from '@/telas/projetos';
import { TelaTerminal } from '@/telas/terminal';
import { TelaWorktrees } from '@/telas/worktrees';

/**
 * Uma rota por tela de specs/forja/06 §2 (caminhos de 06 §1.1), mais
 * Configurações e o onboarding `/comecar` da FJ-030 §5. Todas vivem
 * dentro do shell (`Layout`). O servidor devolve o `index.html` para qualquer
 * caminho fora de `/api`, então recarregar numa rota funda funciona.
 */
export const roteador = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/fila" replace /> },
      { path: 'fila', element: <TelaFila /> },
      { path: 'execucoes/:id', element: <TelaExecucao /> },
      { path: 'execucoes/:id/aprovacao', element: <TelaAprovacao /> },
      { path: 'lotes', element: <TelaLotes /> },
      { path: 'lotes/:id', element: <TelaLote /> },
      { path: 'lotes/:id/planos', element: <TelaMesaPlanos /> },
      { path: 'merge', element: <TelaFilaMerge /> },
      { path: 'terminal', element: <TelaTerminal /> },
      { path: 'projetos', element: <TelaProjetos /> },
      { path: 'projetos/:id', element: <TelaProjeto /> },
      { path: 'conexao', element: <TelaConexao /> },
      { path: 'configuracoes', element: <TelaConfiguracoes /> },
      { path: 'comecar', element: <TelaOnboarding /> },
      { path: 'diagnostico', element: <TelaDiagnostico /> },
      { path: 'historico', element: <TelaHistorico /> },
      { path: 'historico/worktrees', element: <TelaWorktrees /> },
      { path: '*', element: <TelaNaoEncontrada /> },
    ],
  },
]);
