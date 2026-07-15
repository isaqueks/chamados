/**
 * Constantes de TTL do subsistema de auth (specs/03 §4). Valores exatos por
 * tenant ficam pendentes na spec; aqui usamos os defaults recomendados.
 */

/** Sessão: expiração por inatividade (deslizante). Default 8 h. */
export const SESSAO_IDLE_MS = 8 * 60 * 60 * 1000;

/** Sessão: teto absoluto. Default 30 dias. */
export const SESSAO_ABSOLUTA_MS = 30 * 24 * 60 * 60 * 1000;

/** Convite: TTL. Default 7 dias. */
export const CONVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Reset de senha: TTL curto. Default 1 h. */
export const REDEFINICAO_TTL_MS = 60 * 60 * 1000;

/** Nome do cookie opaco de sessão. */
export const COOKIE_SESSAO = 'chamados_sessao';
