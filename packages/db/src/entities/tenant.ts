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
  dias_fechamento_automatico: number;
  ia_resolucao_automatica_habilitada: boolean;
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
    dias_fechamento_automatico: { type: 'int', default: 3 },
    ia_resolucao_automatica_habilitada: { type: 'boolean', default: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
});
