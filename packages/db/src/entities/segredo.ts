import { EntitySchema } from 'typeorm';

/**
 * Segredo cifrado do cofre local (specs/07 §5.2, specs/09 §7). O `id` desta
 * linha É a "referência de segredo" (`*_ref`) guardada nas tabelas de negócio
 * (ex.: `usuario.credencial_servico_ref`, `sistema_alvo.git_credencial_ref`).
 *
 * Nunca guarda valor em claro: só o envelope (DEK embrulhada + valor cifrado).
 * A RLS por `tenant_id` garante que uma `*_ref` só resolve no contexto do tenant
 * dono — nenhum tenant lê segredo de outro (specs/07 §6.3).
 */
export interface Segredo {
  id: string;
  tenant_id: string;
  dek_cifrada: string;
  valor_cifrado: string;
  created_at: Date;
  updated_at: Date;
}

export const SegredoSchema = new EntitySchema<Segredo>({
  name: 'Segredo',
  tableName: 'segredo',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    tenant_id: { type: 'uuid' },
    dek_cifrada: { type: 'text' },
    valor_cifrado: { type: 'text' },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  indices: [{ name: 'ix_segredo_tenant', columns: ['tenant_id'] }],
});
