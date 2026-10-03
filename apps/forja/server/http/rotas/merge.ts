import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas da Fila de merge e do outbox (specs/forja/06 §4.6; 03 §8, §9).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasMerge = {
  merge_obter: viaFachada('merge_obter'),
  merge_reordenar: viaFachada('merge_reordenar'),
  merge_publicado_producao: viaFachada('merge_publicado_producao'),
  merge_liberar_token_schema: viaFachada('merge_liberar_token_schema'),
  outbox_tentar_agora: viaFachada('outbox_tentar_agora'),
} satisfies Pick<
  HandlersRotas,
  | 'merge_obter'
  | 'merge_reordenar'
  | 'merge_publicado_producao'
  | 'merge_liberar_token_schema'
  | 'outbox_tentar_agora'
>;
