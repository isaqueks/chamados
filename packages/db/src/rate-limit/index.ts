import { createHash } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Rate limiting reutilizável (specs/03 §4.1, specs/09 §2 — hardening M10 frente B).
 * Fixed-window counter no Redis (INCR + EXPIRE), chaveado por tenant+IP e por
 * tenant+e-mail. Protege os fluxos de credencial (login, esqueci-senha, redefinir,
 * aceite de convite) contra brute-force/enumeração SEM quebrar o fluxo legítimo:
 *
 *  - LIMITES FOLGADOS por padrão (um humano normal nunca os atinge).
 *  - FAIL-OPEN: qualquer erro/ausência do Redis LIBERA a ação (a segurança de
 *    autenticação não pode depender da disponibilidade do rate limiter).
 *  - Chaves são HASHEADAS (nunca guardam IP/e-mail em claro — LGPD, specs/09 §8).
 *
 * Módulo Node-only (ioredis). Importado pelo web (server actions de auth). A
 * conexão é um singleton preguiçoso que sobrevive ao HMR do Next.
 */

// ---------------------------------------------------------------------------
// Conexão Redis (singleton preguiçoso; mesmos defaults do docker-compose)
// ---------------------------------------------------------------------------

const globalRef = globalThis as unknown as { __chamadosRateLimitRedis?: Redis };

/** Orçamento máximo (ms) por checagem antes de FALHAR ABERTO (Redis lento/fora). */
const ORCAMENTO_MS = 1000;

function obterRedis(): Redis {
  if (!globalRef.__chamadosRateLimitRedis) {
    globalRef.__chamadosRateLimitRedis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? '6379'),
      connectTimeout: 3000,
      maxRetriesPerRequest: 2,
      // Enfileira comandos durante o warm-up da conexão (senão os primeiros
      // comandos falham e o contador nunca conta). O `corridaComTimeout` abaixo
      // é a rede de segurança que garante fail-open se o Redis estiver fora.
      enableOfflineQueue: true,
    });
    // Evita crash do processo por erro não tratado de conexão (fail-open cobre o uso).
    globalRef.__chamadosRateLimitRedis.on('error', () => {});
  }
  return globalRef.__chamadosRateLimitRedis;
}

/** Corre uma promessa contra um timeout; ao estourar, rejeita (→ fail-open). */
function corridaComTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('rate-limit-timeout')), ms)),
  ]);
}

/** Fecha a conexão do rate limiter (uso em scripts/smokes). */
export async function fecharRateLimit(): Promise<void> {
  if (globalRef.__chamadosRateLimitRedis) {
    await globalRef.__chamadosRateLimitRedis.quit().catch(() => {});
    globalRef.__chamadosRateLimitRedis = undefined;
  }
}

// ---------------------------------------------------------------------------
// Núcleo: aplica um limite fixed-window a um identificador
// ---------------------------------------------------------------------------

/** Hash curto (não guardamos IP/e-mail em claro no Redis). */
function h(valor: string): string {
  return createHash('sha256').update(valor).digest('hex').slice(0, 20);
}

export interface ResultadoLimite {
  ok: boolean;
  /** Contagem atual na janela. */
  contagem: number;
  /** Segundos até a janela expirar (quando bloqueado). */
  retryAposS: number;
}

/**
 * Consome 1 unidade de um limite fixed-window. Retorna `ok=false` quando o
 * identificador ULTRAPASSA `max` na janela de `janelaS` segundos. FAIL-OPEN:
 * qualquer erro do Redis retorna `ok=true` (nunca bloqueia o fluxo legítimo).
 *
 * `namespace` separa contadores de ações distintas; `identificador` é o alvo
 * (ip/e-mail) — é hasheado internamente.
 */
export async function aplicarLimite(
  namespace: string,
  identificador: string,
  max: number,
  janelaS: number,
): Promise<ResultadoLimite> {
  if (!identificador || max <= 0 || janelaS <= 0) {
    return { ok: true, contagem: 0, retryAposS: 0 };
  }
  const chave = `rl:${namespace}:${h(identificador)}`;
  try {
    const redis = obterRedis();
    const contagem = await corridaComTimeout(redis.incr(chave), ORCAMENTO_MS);
    if (contagem === 1) {
      // Primeira ocorrência da janela: define o TTL.
      await corridaComTimeout(redis.expire(chave, janelaS), ORCAMENTO_MS);
    }
    if (contagem > max) {
      let ttl = await corridaComTimeout(redis.ttl(chave), ORCAMENTO_MS);
      // -1 (sem TTL) / -2 (expirou entre INCR e TTL): garante um TTL coerente.
      if (ttl < 0) {
        await corridaComTimeout(redis.expire(chave, janelaS), ORCAMENTO_MS);
        ttl = janelaS;
      }
      return { ok: false, contagem, retryAposS: ttl };
    }
    return { ok: true, contagem, retryAposS: 0 };
  } catch {
    // FAIL-OPEN: Redis indisponível/lento NUNCA bloqueia autenticação legítima.
    return { ok: true, contagem: 0, retryAposS: 0 };
  }
}

// ---------------------------------------------------------------------------
// Regras por ação (via env, com defaults FOLGADOS)
// ---------------------------------------------------------------------------

function num(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

/** Master switch: `false` desliga o rate limiting (ex.: testes de carga). */
export function rateLimitHabilitado(): boolean {
  return process.env.RATE_LIMIT_HABILITADO !== 'false';
}

export type AcaoRateLimit = 'login' | 'esqueci_senha' | 'redefinir_senha' | 'aceite_convite';

interface Regra {
  emailMax: number;
  ipMax: number;
  janelaS: number;
}

/** Regras por ação (env override; defaults folgados — um humano nunca atinge). */
function regraDe(acao: AcaoRateLimit): Regra {
  switch (acao) {
    case 'login':
      return {
        emailMax: num('RATE_LIMIT_LOGIN_MAX', 10),
        ipMax: num('RATE_LIMIT_LOGIN_IP_MAX', 30),
        janelaS: num('RATE_LIMIT_LOGIN_JANELA_S', 300),
      };
    case 'esqueci_senha':
      return {
        emailMax: num('RATE_LIMIT_RESET_MAX', 5),
        ipMax: num('RATE_LIMIT_RESET_IP_MAX', 20),
        janelaS: num('RATE_LIMIT_RESET_JANELA_S', 900),
      };
    case 'redefinir_senha':
    case 'aceite_convite':
      // Fluxos por token de uso único: só há IP até resolver a conta.
      return {
        emailMax: 0,
        ipMax: num('RATE_LIMIT_TOKEN_IP_MAX', 20),
        janelaS: num('RATE_LIMIT_TOKEN_JANELA_S', 900),
      };
  }
}

export interface ResultadoRateLimit {
  ok: boolean;
  /** Segundos até liberar (quando bloqueado). */
  retryAposS: number;
}

/**
 * Consome o rate limit de uma AÇÃO de credencial, checando as chaves disponíveis
 * (tenant+IP e/ou tenant+e-mail). Retorna `ok=false` se QUALQUER chave estourar.
 * Sempre FAIL-OPEN em erro de infra. O tenant entra na chave para isolar
 * contadores entre tenants (um tenant barulhento não afeta outro).
 */
export async function consumirRateLimit(
  acao: AcaoRateLimit,
  ctx: { tenantId: string; ip?: string | null; email?: string | null },
): Promise<ResultadoRateLimit> {
  if (!rateLimitHabilitado()) return { ok: true, retryAposS: 0 };

  const regra = regraDe(acao);
  const t = ctx.tenantId;
  let bloqueado = false;
  let retry = 0;

  if (ctx.ip && regra.ipMax > 0) {
    const r = await aplicarLimite(`${acao}:ip`, `${t}|${ctx.ip}`, regra.ipMax, regra.janelaS);
    if (!r.ok) {
      bloqueado = true;
      retry = Math.max(retry, r.retryAposS);
    }
  }
  if (ctx.email && regra.emailMax > 0) {
    const alvo = `${t}|${ctx.email.trim().toLowerCase()}`;
    const r = await aplicarLimite(`${acao}:email`, alvo, regra.emailMax, regra.janelaS);
    if (!r.ok) {
      bloqueado = true;
      retry = Math.max(retry, r.retryAposS);
    }
  }

  return { ok: !bloqueado, retryAposS: retry };
}

/** Mensagem genérica e amigável para exibir quando a ação é bloqueada. */
export function mensagemRateLimit(retryAposS?: number): string {
  const min = retryAposS && retryAposS > 0 ? Math.ceil(retryAposS / 60) : null;
  return min
    ? `Muitas tentativas. Aguarde cerca de ${min} ${min === 1 ? 'minuto' : 'minutos'} e tente novamente.`
    : 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
}
