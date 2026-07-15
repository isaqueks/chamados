import { EntitySchema } from 'typeorm';

/**
 * RedefinicaoSenha: token de uso único para "esqueci a senha" (specs/03 §4.3).
 *
 * NOTA DE DESVIO (relatar): specs/02 lista apenas Usuario/Sessao/Convite como
 * estruturas de auth e não define uma tabela para o token de reset. Ela é
 * necessária para o fluxo da §4.3 (token de uso único, TTL curto) sem poluir a
 * linha de `usuario`. Segue o mesmo padrão de Sessao/Convite: guarda só o
 * `token_hash`, tem TTL e é consumida uma única vez (`usado_em`). Deve virar ADR
 * + adição ao esquema canônico de specs/02.
 */
export interface RedefinicaoSenha {
  id: string;
  tenant_id: string;
  usuario_id: string;
  token_hash: string;
  expira_em: Date;
  usado_em: Date | null;
  created_at: Date;
}

export const RedefinicaoSenhaSchema = new EntitySchema<RedefinicaoSenha>({
  name: 'RedefinicaoSenha',
  tableName: 'redefinicao_senha',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    usuario_id: { type: 'uuid' },
    token_hash: { type: 'text' },
    expira_em: { type: 'timestamptz' },
    usado_em: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
  },
  uniques: [{ name: 'uq_redefinicao_token_hash', columns: ['token_hash'] }],
  indices: [
    { name: 'ix_redefinicao_tenant_usuario', columns: ['tenant_id', 'usuario_id'] },
  ],
});
