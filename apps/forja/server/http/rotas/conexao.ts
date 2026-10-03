import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas da Conexão com o Chamados (specs/forja/06 §4.9; 07 §2). O token e a
 * senha nunca saem do servidor (05 §8).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasConexao = {
  conexoes_listar: viaFachada('conexoes_listar'),
  conexao_criar: viaFachada('conexao_criar', 201),
  conexao_atualizar: viaFachada('conexao_atualizar'),
  conexao_testar: viaFachada('conexao_testar'),
  conexao_relogar: viaFachada('conexao_relogar'),
  conexao_esquecer: viaFachada('conexao_esquecer'),
} satisfies Pick<
  HandlersRotas,
  | 'conexoes_listar'
  | 'conexao_criar'
  | 'conexao_atualizar'
  | 'conexao_testar'
  | 'conexao_relogar'
  | 'conexao_esquecer'
>;
