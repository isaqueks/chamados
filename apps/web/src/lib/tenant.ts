import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import {
  obterAppDataSource,
  resolverTenantPorSlug,
  resolverTenantPorDominio,
  type TenantResolvido,
} from '@chamados/db';
import { dominioProprioValido } from '@chamados/shared';

/**
 * Resolve o tenant da requisição corrente (specs/07 §3.4). Precedência:
 *  1. Domínio próprio: host exato conhecido → tenant do mapa de domínios.
 *  2. Subdomínio: `x-tenant-slug` (extraído pelo proxy) → tenant pelo slug.
 * Memoizado por request com `cache()`. Retorna `null` quando o host não
 * corresponde a um tenant conhecido — nunca vaza a lista de tenants (specs/03 §3).
 */
export const obterTenantAtual = cache(async (): Promise<TenantResolvido | null> => {
  const h = await headers();
  const ds = await obterAppDataSource();

  // 1) Domínio próprio (host exato). Só consulta se o host tem cara de domínio
  //    próprio (evita ida ao banco para `*.localhost`/subdomínios de plataforma).
  const host = h.get('x-tenant-host');
  if (host && dominioProprioValido(host)) {
    const porDominio = await resolverTenantPorDominio(ds, host);
    if (porDominio) return porDominio;
  }

  // 2) Subdomínio (slug).
  const slug = h.get('x-tenant-slug');
  if (!slug) return null;
  return resolverTenantPorSlug(ds, slug);
});
