'use server';

import { obterAppDataSource, solicitarRedefinicao } from '@chamados/db';
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
