import { EntitySchema } from 'typeorm';
import { StatusTenant, valoresEnum } from '@chamados/shared';

/**
 * Branding whitelabel do tenant (specs/07 §3). Campos conhecidos, todos
 * opcionais (jsonb no banco). Tipado como interface concreta (sem index
 * signature) para não colidir com a recursão de tipos do TypeORM em inserts.
 */
export interface ConfigBranding {
  cor_primaria?: string | null;
  cor_secundaria?: string | null;
  logo_light_url?: string | null;
  logo_dark_url?: string | null;
  favicon_url?: string | null;
  agente_ia_nome?: string | null;
  email_remetente_nome?: string | null;
  email_remetente_endereco?: string | null;
}

/** Tenant: empresa/instância whitelabel. Raiz do isolamento multi-tenant. */
export interface Tenant {
  id: string;
  slug: string;
  dominio_proprio: string | null;
  nome: string;
  nome_exibicao: string;
  status: StatusTenant;
  config_branding: ConfigBranding;
  /**
   * Prazo (dias) para o cliente APROVAR ou CONTESTAR um chamado `resolvido`
   * (D-042); sem resposta, o job de manutenção fecha (aprovação tácita). Nome
   * histórico mantido. Default 7; faixa 1–365 validada na gravação.
   */
  dias_fechamento_automatico: number;
  ia_resolucao_automatica_habilitada: boolean;
  /** Instruções adicionais do admin para a IA (D-020) — system prompt da triagem. */
  ia_instrucoes: string | null;
  /** Modelo da IA do tenant (D-044). `null` = padrão da instalação (`IA_MODELO`). */
  ia_modelo: string | null;
  /** Esforço de raciocínio do tenant (D-044). `null` = `IA_ESFORCO`. Texto livre no banco: o worker revalida. */
  ia_esforco: string | null;
  /** Timeout da triagem do tenant em ms (D-044). `null` = `IA_TIMEOUT_MS`. */
  ia_timeout_ms: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const TenantSchema = new EntitySchema<Tenant>({
  name: 'Tenant',
  tableName: 'tenant',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    slug: { type: 'text', unique: true },
    dominio_proprio: { type: 'text', nullable: true },
    nome: { type: 'text' },
    nome_exibicao: { type: 'text' },
    status: {
      type: 'enum',
      enum: valoresEnum(StatusTenant),
      enumName: 'status_tenant',
      default: StatusTenant.em_provisionamento,
    },
    config_branding: { type: 'jsonb', default: {} },
    // D-042: prazo (dias) para o cliente aprovar ou contestar um `resolvido`; default 7.
    dias_fechamento_automatico: { type: 'int', default: 7 },
    ia_resolucao_automatica_habilitada: { type: 'boolean', default: true },
    ia_instrucoes: { type: 'text', nullable: true },
    ia_modelo: { type: 'text', nullable: true },
    ia_esforco: { type: 'text', nullable: true },
    ia_timeout_ms: { type: 'int', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
});
