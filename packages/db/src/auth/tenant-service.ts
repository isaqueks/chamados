import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Papel, StatusTenant } from '@chamados/shared';
import { TenantSchema, type ConfigBranding } from '../entities/tenant';
import { UsuarioSchema } from '../entities/usuario';
import { runInTenantContext } from '../rls';
import { garantirAgenteIA } from './usuario-service';
import { garantirCategoriaGeral } from '../categorias/categoria-service';
import { garantirCanaisNotificacaoDefault } from '../notificacoes/provisionamento';
import { criarSecretStore } from '../secrets/secret-store';
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
  const linhas: LinhaResolver[] = await ds.query('SELECT * FROM chamados_resolver_tenant($1, $2)', [
    slug.trim().toLowerCase(),
    null,
  ]);
  return linhas[0] ?? null;
}

/** Resolve o tenant por domínio próprio (uso pleno a partir do M2). */
export async function resolverTenantPorDominio(
  ds: DataSource,
  dominio: string,
): Promise<TenantResolvido | null> {
  const linhas: LinhaResolver[] = await ds.query('SELECT * FROM chamados_resolver_tenant($1, $2)', [
    null,
    dominio.trim().toLowerCase(),
  ]);
  return linhas[0] ?? null;
}

export interface OpcoesProvisionamento {
  slug: string;
  nome: string;
  nomeExibicao: string;
  status?: StatusTenant;
  dominioProprio?: string | null;
  /** Referência explícita à credencial de serviço do agente_ia (ex.: já no cofre). */
  credencialServicoRef?: string;
}

export interface ResultadoProvisionamento {
  tenant_id: string;
  agente_ia_id: string;
  categoria_geral_id: string;
  criado: boolean;
}

/**
 * Provisiona um tenant (specs/07 §2): cria o Tenant, aplica branding default,
 * cria a Categoria geral e o service account `agente_ia`. A credencial do
 * agente_ia (hoje `AGENTE_IA_TOKEN` em env) é migrada para o COFRE DE SEGREDOS
 * (envelope encryption); `usuario.credencial_servico_ref` passa a apontar para o
 * `id` do segredo (specs/07 §5.2, specs/09 §7). Idempotente — reexecutar com o
 * mesmo slug reaproveita o tenant, a categoria geral e o agente_ia existentes,
 * sem duplicar segredos.
 */
export async function provisionarTenant(
  ds: DataSource,
  opts: OpcoesProvisionamento,
): Promise<ResultadoProvisionamento> {
  const slug = opts.slug.trim().toLowerCase();
  const existente = await resolverTenantPorSlug(ds, slug);
  const tenant_id = existente?.id ?? randomUUID();
  const store = criarSecretStore();

  const { agente_ia_id, categoria_geral_id } = await runInTenantContext(
    ds,
    tenant_id,
    async (em) => {
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

      // Categoria geral do tenant (specs/07 §2.1, passo 5). Idempotente.
      const categoria_geral_id = await garantirCategoriaGeral(em, tenant_id);

      // Canais de notificação default (M9 — e-mail da plataforma). Idempotente.
      await garantirCanaisNotificacaoDefault(em, tenant_id);

      // agente_ia + credencial no cofre. Só cria/guarda segredo se o agente
      // ainda não existir (evita segredo órfão em reexecuções).
      const jaExiste = await em.findOne(UsuarioSchema, {
        where: { papel: Papel.agente_ia },
      });
      if (jaExiste) {
        return { agente_ia_id: jaExiste.id, categoria_geral_id };
      }

      let ref: string | null = opts.credencialServicoRef ?? null;
      if (ref === null) {
        const token = process.env.AGENTE_IA_TOKEN;
        if (token && token.trim() !== '') {
          // Migra o token do env para o cofre; o *_ref é o id do segredo.
          ref = await store.guardar(em, tenant_id, token.trim());
        }
      }
      const agente_ia_id = await garantirAgenteIA(em, tenant_id, ref);
      return { agente_ia_id, categoria_geral_id };
    },
  );

  return { tenant_id, agente_ia_id, categoria_geral_id, criado: !existente };
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
