import { hash, verify } from '@node-rs/argon2';

/**
 * Hashing de senha com Argon2id (specs/03 §2). Parâmetros conservadores de OWASP
 * (m=19 MiB, t=2, p=1). O algoritmo default de @node-rs/argon2 é Argon2id, então
 * não referenciamos o `const enum Algorithm` (proibido com isolatedModules).
 * Nunca reversível; nunca logamos a senha em claro.
 */
const OPCOES_ARGON2 = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Gera o hash Argon2id de uma senha. */
export async function gerarHashSenha(senha: string): Promise<string> {
  return hash(senha, OPCOES_ARGON2);
}

/**
 * Verifica uma senha contra um hash. Retorna `false` (nunca lança) para hash
 * inválido/ausente, para manter a resposta de login genérica (anti-enumeração).
 */
export async function verificarSenha(
  hashArmazenado: string | null | undefined,
  senha: string,
): Promise<boolean> {
  if (!hashArmazenado) return false;
  try {
    return await verify(hashArmazenado, senha);
  } catch {
    return false;
  }
}
