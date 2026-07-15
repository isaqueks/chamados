import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { TenantSchema, type Tenant, type ConfigBranding } from '../entities/tenant';

/**
 * Configurações do tenant (specs/07 §3 e §4): branding whitelabel, prazo de
 * auto-fechamento, guardrail de IA e domínio próprio. Opera sob o
 * `EntityManager` já escopado ao tenant (a policy da tabela `tenant` é por `id`).
 */

/** Carrega o registro completo do tenant corrente (para a tela de config). */
export async function carregarTenant(em: EntityManager, tenantId: string): Promise<Tenant | null> {
  return em.findOne(TenantSchema, { where: { id: tenantId, deleted_at: IsNull() } });
}

/**
 * Mescla campos de branding no `config_branding` (jsonb). Campos `undefined` são
 * ignorados (não sobrescrevem); `null` limpa o campo.
 */
export async function atualizarBranding(
  em: EntityManager,
  tenantId: string,
  parcial: Partial<ConfigBranding>,
): Promise<void> {
  const tenant = await carregarTenant(em, tenantId);
  if (!tenant) return;
  const atual = tenant.config_branding ?? {};
  const merge: ConfigBranding = { ...atual };
  for (const [chave, valor] of Object.entries(parcial)) {
    if (valor !== undefined) {
      (merge as Record<string, unknown>)[chave] = valor;
    }
  }
  await em.update(TenantSchema, { id: tenantId }, { config_branding: merge });
}

/** Atualiza `nome_exibicao` do tenant (título/e-mails). */
export async function atualizarNomeExibicao(
  em: EntityManager,
  tenantId: string,
  nomeExibicao: string,
): Promise<void> {
  await em.update(TenantSchema, { id: tenantId }, { nome_exibicao: nomeExibicao.trim() });
}

/** Configurações gerais do tenant (specs/07 §4.1). */
export interface ConfigGeral {
  dias_fechamento_automatico: number;
  ia_resolucao_automatica_habilitada: boolean;
}

/** Atualiza as configurações gerais (com clamp defensivo do prazo). */
export async function atualizarConfigGeral(
  em: EntityManager,
  tenantId: string,
  config: ConfigGeral,
): Promise<void> {
  const dias = Math.min(Math.max(Math.trunc(config.dias_fechamento_automatico), 1), 365);
  await em.update(
    TenantSchema,
    { id: tenantId },
    {
      dias_fechamento_automatico: dias,
      ia_resolucao_automatica_habilitada: config.ia_resolucao_automatica_habilitada,
    },
  );
}

export type ResultadoDominio = { ok: true } | { ok: false; motivo: 'em_uso' };

/**
 * Define/limpa o domínio próprio do tenant (specs/07 §3.4). Unicidade GLOBAL é
 * garantida pela constraint no banco; violação vira `em_uso`. O formato deve ser
 * validado ANTES (helper puro `dominioProprioValido` em @chamados/shared).
 */
export async function definirDominioProprio(
  em: EntityManager,
  tenantId: string,
  dominio: string | null,
): Promise<ResultadoDominio> {
  try {
    await em.update(TenantSchema, { id: tenantId }, { dominio_proprio: dominio });
    return { ok: true };
  } catch (e: unknown) {
    // 23505 = unique_violation (uq_tenant_dominio_proprio)
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      return { ok: false, motivo: 'em_uso' };
    }
    throw e;
  }
}
