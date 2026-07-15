import { EntitySchema } from 'typeorm';

/**
 * Sessao: sessão server-side revogável (specs/02 e specs/03 §4.4). O cookie
 * carrega apenas um token opaco; o estado (hash do token + expirações + revogação)
 * vive aqui. Nunca guardamos o token em claro — só `token_hash`.
 */
export interface Sessao {
  id: string;
  tenant_id: string;
  usuario_id: string;
  token_hash: string;
  expira_idle_em: Date;
  expira_absoluta_em: Date;
  revogada_em: Date | null;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
}

export const SessaoSchema = new EntitySchema<Sessao>({
  name: 'Sessao',
  tableName: 'sessao',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    usuario_id: { type: 'uuid' },
    token_hash: { type: 'text' },
    expira_idle_em: { type: 'timestamptz' },
    expira_absoluta_em: { type: 'timestamptz' },
    revogada_em: { type: 'timestamptz', nullable: true },
    user_agent: { type: 'text', nullable: true },
    ip: { type: 'inet', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
  },
  uniques: [{ name: 'uq_sessao_token_hash', columns: ['token_hash'] }],
  indices: [{ name: 'ix_sessao_tenant_usuario', columns: ['tenant_id', 'usuario_id'] }],
});
