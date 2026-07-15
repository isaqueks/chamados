'use server';

import { headers } from 'next/headers';
import { obterAppDataSource, solicitarRedefinicao, consumirRateLimit } from '@chamados/db';
import { obterTenantAtual } from '@/lib/tenant';
import { urlAbsoluta } from '@/lib/url';
import { enviarEmailTransacional } from '@/lib/email';

export interface EstadoEsqueci {
  enviado?: boolean;
  erro?: string;
}

/**
 * "Esqueci a senha" (specs/03 §4.3). Resposta SEMPRE genérica ("se existir uma
 * conta, enviaremos um e-mail") — nunca revela se a conta existe. Quando há
 * conta, gera o token e loga a URL (e-mail é stub até M9).
 */
export async function acaoSolicitarReset(
  _prev: EstadoEsqueci,
  formData: FormData,
): Promise<EstadoEsqueci> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { erro: 'Informe seu e-mail.' };

  const tenant = await obterTenantAtual();
  if (!tenant) return { erro: 'Endereço de tenant desconhecido.' };

  // Rate limiting (specs/09 §2): limita pedidos de reset por tenant+IP e
  // tenant+e-mail (anti spam/e-mail bombing). Ao estourar, mantemos a MESMA
  // resposta genérica (anti-enumeração) mas NÃO geramos token nem e-mail.
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
  const rl = await consumirRateLimit('esqueci_senha', { tenantId: tenant.id, ip, email });
  if (!rl.ok) return { enviado: true };

  const ds = await obterAppDataSource();
  const r = await solicitarRedefinicao(ds, tenant.id, email);
  if (r) {
    const url = await urlAbsoluta(`/redefinir-senha?token=${encodeURIComponent(r.token)}`);
    await enviarEmailTransacional({
      tipo: 'reset_senha',
      tenantId: tenant.id,
      destinatario: r.email,
      url,
    });
  }

  // Genérico independentemente de existir conta (anti-enumeração).
  return { enviado: true };
}
