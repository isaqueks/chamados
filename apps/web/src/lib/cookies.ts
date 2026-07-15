import 'server-only';
import { cookies } from 'next/headers';
import { COOKIE_SESSAO } from '@chamados/db';

/**
 * Cookie opaco de sessão (specs/03 §2/§4.4): httpOnly, SameSite=Lax, Secure em
 * produção (em dev sobre http, Secure impediria o cookie). O escopo por domínio
 * do tenant é natural em dev (cada `slug.localhost` é um host distinto).
 */
const SECURE = process.env.NODE_ENV === 'production';

export async function definirCookieSessao(token: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_SESSAO, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    path: '/',
    // 30 dias (teto absoluto da sessão; o servidor revalida idle/absoluto).
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function limparCookieSessao(): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_SESSAO, '', {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** Lê o token de sessão do cookie (para revogação no logout). */
export async function lerTokenSessao(): Promise<string | null> {
  return (await cookies()).get(COOKIE_SESSAO)?.value ?? null;
}
