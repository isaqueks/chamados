import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import {
  obterAppDataSource,
  resolverTenantPorSlug,
  type TenantResolvido,
} from '@chamados/db';

/**
 * Resolve o tenant da requisição corrente a partir do header `x-tenant-slug`
 * (injetado pelo proxy). Memoizado por request com `cache()` para não repetir a
 * query. Retorna `null` quando o host não corresponde a um tenant conhecido —
 * nunca vaza a lista de tenants (specs/03 §3).
 */
export const obterTenantAtual = cache(async (): Promise<TenantResolvido | null> => {
  const h = await headers();
  const slug = h.get('x-tenant-slug');
  if (!slug) return null;
  const ds = await obterAppDataSource();
  return resolverTenantPorSlug(ds, slug);
});
