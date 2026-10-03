import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas da Fila (specs/forja/06 §4.1): lista do chamado_cache com sinais e
 * pré-condições, sincronização com o Chamados (07 §3) e G0 (Implementar).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasFila = {
  fila_listar: viaFachada('fila_listar'),
  fila_sincronizar: viaFachada('fila_sincronizar'),
  chamado_obter: viaFachada('chamado_obter'),
  execucao_criar: viaFachada('execucao_criar', 201),
} satisfies Pick<
  HandlersRotas,
  'fila_listar' | 'fila_sincronizar' | 'chamado_obter' | 'execucao_criar'
>;
