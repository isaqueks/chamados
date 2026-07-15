'use server';

import { redirect } from 'next/navigation';
import { obterAppDataSource, encerrarSessao } from '@chamados/db';
import { obterTenantAtual } from '@/lib/tenant';
import { lerTokenSessao, limparCookieSessao } from '@/lib/cookies';

/** Logout do portal: revoga a sessão server-side e limpa o cookie (specs/03 §4.4). */
export async function acaoLogout(): Promise<void> {
  const tenant = await obterTenantAtual();
  const token = await lerTokenSessao();
  if (tenant && token) {
    const ds = await obterAppDataSource();
    await encerrarSessao(ds, tenant.id, token);
  }
  await limparCookieSessao();
  redirect('/login');
}
