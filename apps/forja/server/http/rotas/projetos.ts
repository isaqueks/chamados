import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas de Projetos (specs/forja/06 §4.8; FJ-030 §1, §5: só a pasta é
 * obrigatória, o resto é autodetectado — `projeto_detectar` mostra o que seria).
 * Sem "Testar comandos" desde FJ-032: a Forja não executa comandos do projeto.
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasProjetos = {
  projetos_listar: viaFachada('projetos_listar'),
  projeto_obter: viaFachada('projeto_obter'),
  projeto_criar: viaFachada('projeto_criar', 201),
  projeto_atualizar: viaFachada('projeto_atualizar'),
  projeto_testar_detectores: viaFachada('projeto_testar_detectores'),
  projeto_detectar: viaFachada('projeto_detectar'),
} satisfies Pick<
  HandlersRotas,
  | 'projetos_listar'
  | 'projeto_obter'
  | 'projeto_criar'
  | 'projeto_atualizar'
  | 'projeto_testar_detectores'
  | 'projeto_detectar'
>;
