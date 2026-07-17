import { EntitySchema } from 'typeorm';

/**
 * PreferenciaNotificacao (specs/02, specs/06 §7): granularidade
 * (usuário × evento × canal) → habilitado. A AUSÊNCIA de linha significa o DEFAULT
 * do CATÁLOGO (`defaultDoEvento`): eventos ruidosos (mudança de status/prioridade)
 * nascem DESLIGADOS (anti-flood, opt-in); os demais, ligados. Eventos OBRIGATÓRIOS
 * (§7) nunca são desabilitáveis — o serviço recusa e o dispatcher ignora a
 * preferência.
 */
export interface PreferenciaNotificacao {
  id: string;
  tenant_id: string;
  usuario_id: string;
  /** Chave notificável (specs/06 §6): 'chamado_criado', 'mudanca_status', ... */
  evento: string;
  canal_id: string;
  habilitado: boolean;
  created_at: Date;
  updated_at: Date;
}

export const PreferenciaNotificacaoSchema = new EntitySchema<PreferenciaNotificacao>({
  name: 'PreferenciaNotificacao',
  tableName: 'preferencia_notificacao',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    usuario_id: { type: 'uuid' },
    evento: { type: 'text' },
    canal_id: { type: 'uuid' },
    habilitado: { type: 'boolean', default: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  uniques: [
    {
      name: 'uq_preferencia_usuario_evento_canal',
      columns: ['tenant_id', 'usuario_id', 'evento', 'canal_id'],
    },
  ],
  indices: [{ name: 'ix_preferencia_tenant_usuario', columns: ['tenant_id', 'usuario_id'] }],
});
