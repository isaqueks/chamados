'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  obterAppDataSource,
  autenticarComSenha,
  consumirRateLimit,
  mensagemRateLimit,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import { caminhoSeguro } from '@/lib/caminho';
import { obterTenantAtual } from '@/lib/tenant';
import { definirCookieSessao } from '@/lib/cookies';

export interface EstadoLogin {
  erro?: string;
}

/**
 * Autentica no tenant resolvido (specs/03 §4.1). Falha sempre com mensagem
 * genérica (anti-enumeração). Em sucesso, grava o cookie de sessão e redireciona.
 */
export async function acaoLogin(_prev: EstadoLogin, formData: FormData): Promise<EstadoLogin> {
  const email = String(formData.get('email') ?? '').trim();
  const senha = String(formData.get('senha') ?? '');
  if (!email || !senha) return { erro: 'Informe e-mail e senha.' };

  const tenant = await obterTenantAtual();
  if (!tenant) return { erro: 'Endereço de tenant desconhecido.' };

  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;

  // Rate limiting anti-brute-force (specs/03 §4.1, specs/09 §2): por tenant+IP e
  // tenant+e-mail, limites folgados. Bloqueio → mensagem genérica (não revela se a
  // conta existe nem por que falhou). Fail-open embutido (Redis fora → libera).
  const rl = await consumirRateLimit('login', { tenantId: tenant.id, ip, email });
  if (!rl.ok) return { erro: mensagemRateLimit(rl.retryAposS) };

  const ds = await obterAppDataSource();
  const r = await autenticarComSenha(ds, tenant, {
    email,
    senha,
    userAgent: h.get('user-agent') ?? undefined,
    ip,
  });

  if (!r.ok) return { erro: 'E-mail ou senha inválidos.' };

  await definirCookieSessao(r.token);
  // Destino preservado do deep link (`next`, REVALIDADO aqui — só caminho
  // interno; os layouts corrigem a área se não for a do papel). Sem destino,
  // redireciona por papel (specs/03 §4.1, specs/08 §1): cliente → portal;
  // operador/admin → painel. `agente_ia` nunca chega aqui (não loga por senha).
  const next = caminhoSeguro(String(formData.get('next') ?? ''));
  redirect(next ?? (r.usuario.papel === Papel.cliente ? '/portal' : '/app'));
}
