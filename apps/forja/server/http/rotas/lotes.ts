import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas de Lotes e da Mesa de planos (specs/forja/06 §4.4, §4.5; 03 §7).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasLotes = {
  lotes_listar: viaFachada('lotes_listar'),
  lote_previa: viaFachada('lote_previa'),
  lote_criar: viaFachada('lote_criar', 201),
  lote_obter: viaFachada('lote_obter'),
  lote_planos: viaFachada('lote_planos'),
  lote_aprovar_limpos: viaFachada('lote_aprovar_limpos'),
  lote_pausar: viaFachada('lote_pausar'),
  lote_cancelar_pendentes: viaFachada('lote_cancelar_pendentes'),
} satisfies Pick<
  HandlersRotas,
  | 'lotes_listar'
  | 'lote_previa'
  | 'lote_criar'
  | 'lote_obter'
  | 'lote_planos'
  | 'lote_aprovar_limpos'
  | 'lote_pausar'
  | 'lote_cancelar_pendentes'
>;
