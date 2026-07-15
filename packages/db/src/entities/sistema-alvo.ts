import { EntitySchema } from 'typeorm';

/**
 * Configuração não-secreta de acesso a logs (caminhos/URLs/queries). Valores
 * primitivos JSON (sem `unknown`) para não colidir com a recursão de tipos do
 * TypeORM em inserts — mesmo motivo do `ConfigBranding` ser tipo concreto.
 * Segredos NUNCA vão aqui: usam `logs_credencial_ref`.
 */
export type LogsConfig = Record<string, string | number | boolean | null>;

/**
 * SistemaAlvo (specs/02 e specs/07 §5): sistema de software do tenant sobre o
 * qual os chamados são abertos. Guarda repositório git, fontes de logs e conexão
 * SOMENTE-LEITURA ao BD do sistema. Credenciais NUNCA em claro — apenas
 * referências (`*_ref`) ao cofre de segredos (specs/09 §7).
 */
export interface SistemaAlvo {
  id: string;
  tenant_id: string;
  nome: string;
  descricao: string | null;
  git_repo_url: string;
  git_credencial_ref: string | null;
  git_branch_padrao: string;
  logs_tipo: string | null;
  logs_config: LogsConfig;
  logs_credencial_ref: string | null;
  bd_tipo: string | null;
  bd_host: string | null;
  bd_porta: number | null;
  bd_nome: string | null;
  bd_credencial_ref: string | null;
  ativo: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const SistemaAlvoSchema = new EntitySchema<SistemaAlvo>({
  name: 'SistemaAlvo',
  tableName: 'sistema_alvo',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    tenant_id: { type: 'uuid' },
    nome: { type: 'text' },
    descricao: { type: 'text', nullable: true },
    git_repo_url: { type: 'text' },
    git_credencial_ref: { type: 'text', nullable: true },
    git_branch_padrao: { type: 'text', default: 'main' },
    logs_tipo: { type: 'text', nullable: true },
    logs_config: { type: 'jsonb', default: {} },
    logs_credencial_ref: { type: 'text', nullable: true },
    bd_tipo: { type: 'text', nullable: true },
    bd_host: { type: 'text', nullable: true },
    bd_porta: { type: 'int', nullable: true },
    bd_nome: { type: 'text', nullable: true },
    bd_credencial_ref: { type: 'text', nullable: true },
    ativo: { type: 'boolean', default: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  uniques: [{ name: 'uq_sistema_alvo_tenant_nome', columns: ['tenant_id', 'nome'] }],
  indices: [{ name: 'ix_sistema_alvo_tenant', columns: ['tenant_id'] }],
});
