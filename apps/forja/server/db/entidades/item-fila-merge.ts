import { EntitySchema } from 'typeorm';
import type { EstadoItemFilaMerge, ModoAvancoRef } from '../../../comum/estados';
import { ListaCaminhosSchema } from '../json';
import { SQL_ITEM_FILA_ATIVO, SQL_ITEM_FILA_PROCESSANDO } from '../sql';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `item_fila_merge` (specs/forja/02 §4.12): uma entrada na fila SERIAL por
 * `(projeto_id, branch_destino)` (F-10). I-5 no banco: um item ativo por
 * execução e no máximo um em processamento (`integrando`/`verificando`/
 * `publicando`) por fila — dois merges simultâneos no mesmo destino são
 * impossíveis mesmo com bug no despachante.
 *
 * `sha_destino_antes` é o valor "antigo" do CAS da ref; `sha_integrado` é o
 * que o boot confere com `merge-base --is-ancestor` para nunca re-mergear (I-8).
 */
export interface ItemFilaMerge extends ComTempo {
  id: string;
  projeto_id: string;
  branch_destino: string;
  execucao_id: string;
  aprovacao_id: string;
  ordem: number;
  estado: EstadoItemFilaMerge;
  motivo: string | null;
  tentativas_conflito: number;
  sha_destino_antes: string | null;
  sha_integrado: string | null;
  patch_id_integrado: string | null;
  arquivos_em_conflito: string[] | null;
  modo_avanco: ModoAvancoRef | null;
  push_em: string | null;
  copia_local_atras: boolean;
  worktree_integracao_dir: string | null;
}

export const ItemFilaMergeSchema = new EntitySchema<ItemFilaMerge>({
  name: 'ItemFilaMerge',
  tableName: 'item_fila_merge',
  columns: {
    id: pk(),
    projeto_id: texto(),
    branch_destino: texto(),
    execucao_id: texto(),
    aprovacao_id: texto(),
    ordem: inteiro(),
    estado: texto(),
    motivo: texto(true),
    tentativas_conflito: inteiro(),
    sha_destino_antes: texto(true),
    sha_integrado: texto(true),
    patch_id_integrado: texto(true),
    arquivos_em_conflito: json(ListaCaminhosSchema, 'item_fila_merge.arquivos_em_conflito', true),
    modo_avanco: texto(true),
    push_em: texto(true),
    copia_local_atras: booleano(),
    worktree_integracao_dir: texto(true),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_item_fila_execucao_ativo',
      columns: ['execucao_id'],
      unique: true,
      where: SQL_ITEM_FILA_ATIVO,
    },
    {
      name: 'ux_item_fila_processando',
      columns: ['projeto_id', 'branch_destino'],
      unique: true,
      where: SQL_ITEM_FILA_PROCESSANDO,
    },
    {
      name: 'ix_item_fila_ordem',
      columns: ['projeto_id', 'branch_destino', 'estado', 'ordem'],
    },
  ],
});
