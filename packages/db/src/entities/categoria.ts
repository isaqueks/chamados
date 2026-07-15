import { EntitySchema } from 'typeorm';

/**
 * Categoria (specs/02): classificação do tenant. Um chamado referencia um
 * SistemaAlvo OU a categoria geral do tenant (fallback quando não há sistema
 * específico — specs/07 §5). A categoria geral é criada no provisionamento e é
 * protegida (não deletável/desativável).
 */
export interface Categoria {
  id: string;
  tenant_id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const CategoriaSchema = new EntitySchema<Categoria>({
  name: 'Categoria',
  tableName: 'categoria',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    tenant_id: { type: 'uuid' },
    nome: { type: 'text' },
    descricao: { type: 'text', nullable: true },
    ativo: { type: 'boolean', default: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  uniques: [{ name: 'uq_categoria_tenant_nome', columns: ['tenant_id', 'nome'] }],
  indices: [{ name: 'ix_categoria_tenant', columns: ['tenant_id'] }],
});
