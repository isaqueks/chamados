import { EntitySchema } from 'typeorm';
import { Papel, StatusUsuario, valoresEnum } from '@chamados/shared';

/** Usuario: pessoas e o service account de IA. Modelo por-tenant. */
export interface Usuario {
  id: string;
  tenant_id: string;
  email: string;
  nome: string;
  papel: Papel;
  senha_hash: string | null;
  credencial_servico_ref: string | null;
  status: StatusUsuario;
  avatar_url: string | null;
  ultimo_acesso_em: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const UsuarioSchema = new EntitySchema<Usuario>({
  name: 'Usuario',
  tableName: 'usuario',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    tenant_id: { type: 'uuid' },
    email: { type: 'text' },
    nome: { type: 'text' },
    papel: {
      type: 'enum',
      enum: valoresEnum(Papel),
      enumName: 'papel',
    },
    senha_hash: { type: 'text', nullable: true },
    credencial_servico_ref: { type: 'text', nullable: true },
    status: {
      type: 'enum',
      enum: valoresEnum(StatusUsuario),
      enumName: 'status_usuario',
      default: StatusUsuario.ativo,
    },
    avatar_url: { type: 'text', nullable: true },
    ultimo_acesso_em: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  uniques: [{ name: 'uq_usuario_tenant_email', columns: ['tenant_id', 'email'] }],
  indices: [{ name: 'ix_usuario_tenant', columns: ['tenant_id'] }],
});
