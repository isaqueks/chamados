import 'server-only';
import { headers } from 'next/headers';

/**
 * Monta uma URL absoluta no domínio do tenant corrente, a partir dos headers da
 * requisição. Usada para links de convite e de reset (que caem no domínio do
 * tenant, onde o proxy resolve o slug).
 */
export async function urlAbsoluta(path: string): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto =
    h.get('x-forwarded-proto') ?? (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}${path}`;
}
