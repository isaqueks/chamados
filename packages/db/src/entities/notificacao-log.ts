import { EntitySchema } from 'typeorm';
import { CanalNotificacaoTipo, StatusNotificacao } from '../notificacoes/tipos';

/**
 * NotificacaoLog (specs/02, specs/06 §8.3-8.4): registro de cada tentativa de
 * entrega — base da IDEMPOTÊNCIA (índice único em `idempotency_key`) e do status
 * observável. Append-de-tentativas: o mesmo (evento × destinatário × canal)
 * reaproveita a MESMA linha (upsert por `idempotency_key`); um status de sucesso
 * NUNCA é reenviado. `chamado_id` é NULL para e-mails transacionais (convite/reset).
 */
export interface NotificacaoLog {
  id: string;
  tenant_id: string;
  /** hash(evento+destinatário+canal) — único global (specs/06 §8.3). */
  idempotency_key: string;
  chamado_id: string | null;
  /** Chave notificável / 'convite' / 'reset_senha' / 'webhook_desativado'. */
  evento: string;
  canal: CanalNotificacaoTipo;
  /** Destinatário humano (quando aplicável). */
  destinatario_id: string | null;
  /** Destino textual (e-mail ou host do webhook) — observabilidade, sem segredo. */
  destino: string;
  status: StatusNotificacao;
  tentativas: number;
  ultimo_erro: string | null;
  /** message-id do provider (conciliação — specs/06 §8.4). */
  id_externo: string | null;
  created_at: Date;
  updated_at: Date;
}

export const NotificacaoLogSchema = new EntitySchema<NotificacaoLog>({
  name: 'NotificacaoLog',
  tableName: 'notificacao_log',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    idempotency_key: { type: 'text' },
    chamado_id: { type: 'uuid', nullable: true },
    evento: { type: 'text' },
    canal: {
      type: 'enum',
      enum: Object.values(CanalNotificacaoTipo),
      enumName: 'canal_notificacao_tipo',
    },
    destinatario_id: { type: 'uuid', nullable: true },
    destino: { type: 'text' },
    status: {
      type: 'enum',
      enum: Object.values(StatusNotificacao),
      enumName: 'status_notificacao',
      default: StatusNotificacao.pendente,
    },
    tentativas: { type: 'int', default: 0 },
    ultimo_erro: { type: 'text', nullable: true },
    id_externo: { type: 'text', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  uniques: [{ name: 'uq_notificacao_log_idempotency', columns: ['idempotency_key'] }],
  indices: [
    { name: 'ix_notificacao_log_tenant_chamado', columns: ['tenant_id', 'chamado_id'] },
    { name: 'ix_notificacao_log_tenant_created', columns: ['tenant_id', 'created_at'] },
  ],
});
