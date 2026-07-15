import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { StatusTenant } from '@chamados/shared';
import { TenantSchema, type ConfigBranding } from '../entities/tenant';
import { runInTenantContext } from '../rls';
import { garantirAgenteIA } from './usuario-service';
import type { TenantResolvido } from './tipos';

/** Branding neutro default aplicado no provisionamento (specs/07 §2.1/§3). */
function brandingDefault(): ConfigBranding {
  return {
    cor_primaria: null,
    cor_secundaria: null,
    logo_light_url: null,
    logo_dark_url: null,
    favicon_url: null,
    agente_ia_nome: 'Assistente',
  };
}

interface LinhaResolver {
  id: string;
  slug: string;
  dominio_proprio: string | null;
  nome_exibicao: string;
  status: StatusTenant;
  config_branding: ConfigBranding;
}

/**
 * Resolve o tenant por slug (subdomínio) usando a função SECURITY DEFINER
 * `chamados_resolver_tenant` — necessária porque a app roda com role SEM
 * BYPASSRLS e a policy da tabela `tenant` esconderia todas as linhas antes de
 * haver contexto de tenant. Nunca lista tenants; retorna no máximo um.
 */
export async function resolverTenantPorSlug(
  ds: DataSource,
  slug: string,
): Promise<TenantResolvido | null> {
  const linhas: LinhaResolver[] = await ds.query(
    'SELECT * FROM chamados_resolver_tenant($1, $2)',
    [slug.trim().toLowerCase(), null],
  );
  return linhas[0] ?? null;
}

/** Resolve o tenant por domínio próprio (uso pleno a partir do M2). */
export async function resolverTenantPorDominio(
  ds: DataSource,
  dominio: string,
): Promise<TenantResolvido | null> {
  const linhas: LinhaResolver[] = await ds.query(
    'SELECT * FROM chamados_resolver_tenant($1, $2)',
    [null, dominio.trim().toLowerCase()],
  );
  return linhas[0] ?? null;
}

export interface OpcoesProvisionamento {
  slug: string;
  nome: string;
  nomeExibicao: string;
  status?: StatusTenant;
  dominioProprio?: string | null;
  /** Ponteiro provisório para a credencial de serviço do agente_ia (env/config). */
  credencialServicoRef?: string;
}

export interface ResultadoProvisionamento {
  tenant_id: string;
  agente_ia_id: string;
  criado: boolean;
}

/**
 * Provisiona um tenant (specs/07 §2): cria o Tenant, aplica branding default e
 * cria o service account `agente_ia`. Idempotente — reexecutar com o mesmo slug
 * reaproveita o tenant existente e não duplica o agente_ia. (Categoria geral e
 * convite do admin inicial: Categoria é M2; o admin é criado pelo seed/convite.)
 */
export async function provisionarTenant(
  ds: DataSource,
  opts: OpcoesProvisionamento,
): Promise<ResultadoProvisionamento> {
  const slug = opts.slug.trim().toLowerCase();
  const existente = await resolverTenantPorSlug(ds, slug);
  const tenant_id = existente?.id ?? randomUUID();
  const credencialRef = opts.credencialServicoRef ?? `env:AGENTE_IA_TOKEN#${slug}`;

  const agente_ia_id = await runInTenantContext(ds, tenant_id, async (em) => {
    if (!existente) {
      await em.insert(TenantSchema, {
        id: tenant_id,
        slug,
        dominio_proprio: opts.dominioProprio ?? null,
        nome: opts.nome,
        nome_exibicao: opts.nomeExibicao,
        status: opts.status ?? StatusTenant.em_provisionamento,
        config_branding: brandingDefault(),
      });
    }
    return garantirAgenteIA(em, tenant_id, credencialRef);
  });

  return { tenant_id, agente_ia_id, criado: !existente };
}

/** Atualiza o status de acesso do tenant (ex.: em_provisionamento → ativo). */
export async function atualizarStatusTenant(
  ds: DataSource,
  tenant_id: string,
  status: StatusTenant,
): Promise<void> {
  await runInTenantContext(ds, tenant_id, async (em) => {
    await em.update(TenantSchema, { id: tenant_id }, { status });
  });
}
