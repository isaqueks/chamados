/** Conexão Redis do worker (defaults batem com o docker-compose). */
export const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? '6379'),
};

function num(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

/**
 * Configuração do agente de IA (specs/05 §8, §10). Seleção de provider por
 * `IA_PROVIDER` (fake|claude, default fake). Os LIMITES são passados ao provider
 * em `AIProviderInput.limites` (o provider honra timeout/budget/maxTurnos).
 */
export const iaConfig = {
  /** 'fake' (default, determinístico) | 'claude' (Claude Agent SDK). */
  provider: (process.env.IA_PROVIDER ?? 'fake') as 'fake' | 'claude',
  /** Modelo do provider real (specs/05 §10 — Opus 4.8). */
  modelo: process.env.IA_MODELO ?? 'claude-opus-4-8',
  apiKey: process.env.ANTHROPIC_API_KEY,
  /**
   * Token de assinatura (D-012): `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
   * Alternativa à API key para uso próprio/dev; `ANTHROPIC_API_KEY` tem precedência
   * na cadeia do CLI. Ao menos uma das duas é exigida quando IA_PROVIDER=claude.
   */
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  limites: {
    timeoutMs: num('IA_TIMEOUT_MS', 600_000),
    budgetUsd: num('IA_BUDGET_USD', 5),
    maxTurnos: num('IA_MAX_TURNOS', 20),
  },
  /** Resolução automática (specs/05 §6): PR e link do chamado. */
  resolucao: {
    /** Timeout do POST de abertura de PR no GitHub (ms). */
    prTimeoutMs: num('IA_RESOLUCAO_PR_TIMEOUT_MS', 10_000),
    /** Base URL do painel para montar o link do chamado no corpo do PR (ou null). */
    appBaseUrl: process.env.APP_BASE_URL?.trim() || null,
  },
};

/**
 * Fila `triagem-ia` (specs/01 §3.5): concorrência global BAIXA (é cara) + lock
 * Redis por tenant (1 execução simultânea por tenant — evita um tenant esgotar o
 * worker/budget, specs/05 §2).
 */
export const triagemConfig = {
  concorrencia: num('TRIAGEM_CONCURRENCY', 2),
  lock: {
    /** TTL do lock por tenant (renovado a cada execução; > timeout do provider). */
    ttlMs: num('TRIAGEM_LOCK_TTL_MS', 900_000),
    /** Espera máxima por lock antes de devolver o job à fila (retry). */
    esperaMaxMs: num('TRIAGEM_LOCK_ESPERA_MS', 30_000),
    intervaloMs: num('TRIAGEM_LOCK_INTERVALO_MS', 500),
  },
};

export const FILA_HEALTHCHECK = 'healthcheck';
