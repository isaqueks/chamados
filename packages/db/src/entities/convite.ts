import { EntitySchema } from 'typeorm';
import { Papel, StatusConvite, valoresEnum } from '@chamados/shared';

/**
 * Convite: convite de acesso emitido por admin/operador (specs/03 §4.2). Um
 * convite aceito materializa uma linha de `usuario` com o papel convidado. Só
 * guardamos `token_hash` (nunca o token em claro).
 */
export interface Convite {
  id: string;
  tenant_id: string;
  email: string;
  papel: Papel;
  token_hash: string;
  expira_em: Date;
  status: StatusConvite;
  criado_por: string | null;
  aceito_em: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const ConviteSchema = new EntitySchema<Convite>({
  name: 'Convite',
  tableName: 'convite',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    email: { type: 'text' },
    papel: { type: 'enum', enum: valoresEnum(Papel), enumName: 'papel' },
    token_hash: { type: 'text' },
    expira_em: { type: 'timestamptz' },
    status: {
      type: 'enum',
      enum: valoresEnum(StatusConvite),
      enumName: 'status_convite',
      default: StatusConvite.pendente,
    },
    criado_por: { type: 'uuid', nullable: true },
    aceito_em: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  uniques: [{ name: 'uq_convite_token_hash', columns: ['token_hash'] }],
  indices: [{ name: 'ix_convite_tenant_email', columns: ['tenant_id', 'email'] }],
});
