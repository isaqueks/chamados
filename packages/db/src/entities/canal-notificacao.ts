import { EntitySchema } from 'typeorm';
import { CanalNotificacaoTipo } from '../notificacoes/tipos';

/**
 * Configuração NÃO-secreta de um canal. Para o webhook: `url` (endpoint HTTPS) e
 * `segredo_ref` (ponteiro para o cofre — o segredo HMAC NUNCA em claro). Tipo
 * concreto (sem index signature) para não colidir com a recursão do TypeORM.
 */
export interface ConfigCanal {
  url?: string | null;
  segredo_ref?: string | null;
}

/**
 * CanalNotificacao (specs/02, specs/06 §2-3): configuração de um gateway plugável
 * POR TENANT. Fase 1: `email` (plataforma — sempre disponível, criado no
 * provisionamento) e `webhook` (URL + segredo HMAC; desativa após N falhas
 * consecutivas — specs/06 §3.2). `falhas_consecutivas`/`desativado_em`/`ultimo_erro`
 * são extensões do M9 sobre o schema mínimo de specs/02 (relatado na entrega).
 */
export interface CanalNotificacao {
  id: string;
  tenant_id: string;
  tipo: CanalNotificacaoTipo;
  config: ConfigCanal;
  ativo: boolean;
  /** Contador de falhas consecutivas (webhook); zera a cada sucesso (specs/06 §3.2). */
  falhas_consecutivas: number;
  /** Preenchido quando o canal é desativado automaticamente por excesso de falhas. */
  desativado_em: Date | null;
  ultimo_erro: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const CanalNotificacaoSchema = new EntitySchema<CanalNotificacao>({
  name: 'CanalNotificacao',
  tableName: 'canal_notificacao',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    tipo: {
      type: 'enum',
      enum: Object.values(CanalNotificacaoTipo),
      enumName: 'canal_notificacao_tipo',
    },
    config: { type: 'jsonb', default: {} },
    ativo: { type: 'boolean', default: true },
    falhas_consecutivas: { type: 'int', default: 0 },
    desativado_em: { type: 'timestamptz', nullable: true },
    ultimo_erro: { type: 'text', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  uniques: [{ name: 'uq_canal_notificacao_tenant_tipo', columns: ['tenant_id', 'tipo'] }],
  indices: [{ name: 'ix_canal_notificacao_tenant', columns: ['tenant_id'] }],
});
