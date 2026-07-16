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
    // D-014: exploração nível Claude Code (Read/Grep/Glob) usa mais turnos —
    // default elevado de 20 → 50 (o usuário aceitou o custo maior por triagem).
    maxTurnos: num('IA_MAX_TURNOS', 50),
  },
  /**
   * Mapeamento de conhecimento do sistema (D-013): execução dedicada, mais cara e
   * com mais turnos que a triagem (explora o repo inteiro). Budget/turnos/timeout
   * próprios; teto de caracteres do resumo injetado nas triagens.
   */
  mapa: {
    timeoutMs: num('IA_MAPA_TIMEOUT_MS', 600_000),
    budgetUsd: num('IA_MAPA_BUDGET_USD', 10),
    maxTurnos: num('IA_MAPA_MAX_TURNOS', 40),
    maxChars: num('IA_MAPA_MAX_CHARS', 12_000),
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
    /**
     * TTL CURTO renovado por heartbeat durante a execução (D-016): se o worker
     * morrer sem liberar (kill/crash — no Windows o Ctrl+C mata sem sinal), o
     * lock órfão expira em ≤ este TTL. A renovação contínua cobre execuções
     * legítimas longas (mapa + triagem podem passar de 20 min).
     */
    ttlMs: num('TRIAGEM_LOCK_TTL_MS', 90_000),
    /** Intervalo do heartbeat de renovação (≈ TTL/3 — duas renovações de folga). */
    renovacaoMs: num('TRIAGEM_LOCK_RENOVACAO_MS', 30_000),
    /** Espera máxima por lock dentro do processador antes de devolver o job. */
    esperaMaxMs: num('TRIAGEM_LOCK_ESPERA_MS', 30_000),
    intervaloMs: num('TRIAGEM_LOCK_INTERVALO_MS', 500),
  },
};

export const FILA_HEALTHCHECK = 'healthcheck';
