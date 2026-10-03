import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas do Histórico e das Worktrees (specs/forja/06 §4.11; retenção em 02 §9).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasHistorico = {
  historico_listar: viaFachada('historico_listar'),
  worktrees_listar: viaFachada('worktrees_listar'),
  worktree_limpar: viaFachada('worktree_limpar'),
} satisfies Pick<HandlersRotas, 'historico_listar' | 'worktrees_listar' | 'worktree_limpar'>;
