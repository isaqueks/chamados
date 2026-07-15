import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Proxy (antigo "middleware" — renomeado no Next 16). Resolve o SLUG do tenant a
 * partir do host, ANTES da autenticação, e o injeta no header `x-tenant-slug`
 * para os Server Components/Actions (specs/03 §3, specs/07 §3.4).
 *
 * IMPORTANTE: o proxy roda no runtime Edge e NÃO acessa o banco. Ele só extrai o
 * candidato a slug; a resolução slug → tenant (via função SECURITY DEFINER) e a
 * validação de sessão acontecem no servidor (lib/tenant.ts, lib/sessao.ts).
 *
 * Estratégia (M1):
 *  1. Subdomínio: `acme.localhost:3000` → slug `acme`.
 *  2. Fallback de DEV: querystring `?tenant=acme` ou header `x-tenant-slug`
 *     (facilita testar sem configurar subdomínios). Domínio próprio é M2.
 */

/** Subdomínios/rótulos reservados que NÃO são slugs de tenant. */
const RESERVADOS = new Set(['www', 'app', 'api', 'admin', 'mail', 'localhost']);

function extrairSlug(request: NextRequest): string | null {
  // Fallback de dev explícito tem prioridade (querystring).
  const qs = request.nextUrl.searchParams.get('tenant');
  if (qs) return qs.trim().toLowerCase();

  const host = (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (!host) return null;

  // `<slug>.localhost` (dev) ou `<slug>.<dominio>` (subdomínio da plataforma).
  const partes = host.split('.');
  if (host.endsWith('.localhost') && partes.length >= 2) {
    const slug = partes[0]!;
    return RESERVADOS.has(slug) ? null : slug;
  }
  // Domínios com 3+ rótulos: primeiro rótulo é o slug (ex.: acme.chamados.app).
  if (partes.length >= 3) {
    const slug = partes[0]!;
    return RESERVADOS.has(slug) ? null : slug;
  }

  // Último fallback de dev: header explícito.
  const header = request.headers.get('x-tenant-slug');
  return header ? header.trim().toLowerCase() : null;
}

export function proxy(request: NextRequest): NextResponse {
  const slug = extrairSlug(request);

  const headers = new Headers(request.headers);
  if (slug) headers.set('x-tenant-slug', slug);
  else headers.delete('x-tenant-slug'); // evita spoofing quando não há slug real

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Roda em todas as rotas exceto assets estáticos e internals do Next.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
