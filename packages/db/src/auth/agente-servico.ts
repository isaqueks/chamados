import { timingSafeEqual } from 'node:crypto';

/**
 * Autenticação máquina-a-máquina do `agente_ia` (specs/03 §6).
 *
 * PROVISÓRIO (até o cofre de segredos do M2): a credencial de serviço é um token
 * lido de env/config (`AGENTE_IA_TOKEN`), comparado em tempo constante. O
 * `agente_ia` NÃO usa o fluxo de login por senha (senha_hash NULL) e não tem
 * sessão interativa; o worker do pipeline porta este token para agir no domínio
 * do chamado. Escopo por tenant e rotação de segredo ficam para o M2 (cofre).
 */
function comparaConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Valida a credencial de serviço apresentada por um cliente máquina-a-máquina.
 * Retorna `false` se o token não estiver configurado ou não bater.
 */
export function autenticarAgenteServico(tokenApresentado: string): boolean {
  const esperado = process.env.AGENTE_IA_TOKEN;
  if (!esperado || esperado.length === 0) return false;
  return comparaConstante(tokenApresentado, esperado);
}
