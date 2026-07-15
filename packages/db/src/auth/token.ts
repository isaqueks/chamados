import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Tokens opacos para cookie de sessão, convite e reset de senha (specs/03).
 * O token em CLARO só existe no cookie/URL entregue ao usuário; o banco guarda
 * apenas o hash SHA-256 (`token_hash`). Assim, vazar o banco não vaza sessões.
 */

/** Gera um token opaco de alta entropia (32 bytes, base64url). */
export function gerarTokenOpaco(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash determinístico (SHA-256 hex) do token, para armazenar/lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Comparação de hashes em tempo constante (evita timing attacks no lookup). */
export function hashesIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
