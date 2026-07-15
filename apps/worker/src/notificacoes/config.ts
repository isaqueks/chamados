/**
 * Configuração da camada de notificações do worker (specs/06, specs/07). Fica no
 * módulo de notificações (não no `config.ts` da triagem) para manter o território
 * do M9 isolado. Defaults de dev batem com o Mailpit do docker-compose.
 */

function num(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

export const notificacoesConfig = {
  /** SMTP da PLATAFORMA (dev: Mailpit). Remetente padrão dos e-mails do tenant. */
  smtp: {
    host: process.env.NOTIFICACOES_SMTP_HOST ?? 'localhost',
    port: num('NOTIFICACOES_SMTP_PORT', 1025),
    secure: process.env.NOTIFICACOES_SMTP_SECURE === 'true',
    user: process.env.NOTIFICACOES_SMTP_USER || undefined,
    pass: process.env.NOTIFICACOES_SMTP_PASS || undefined,
  },
  /**
   * Remetente default da plataforma (specs/07 §3): usado quando o tenant não tem
   * remetente próprio no branding. O display name real do tenant entra no `from`.
   */
  remetente: {
    nome: process.env.NOTIFICACOES_REMETENTE_NOME ?? 'Chamados',
    email: process.env.NOTIFICACOES_REMETENTE_EMAIL ?? 'nao-responda@chamados.local',
  },
  webhook: {
    timeoutMs: num('NOTIFICACOES_WEBHOOK_TIMEOUT_MS', 5000),
    /** Falhas consecutivas até desativar o canal automaticamente (specs/06 §3.2). */
    maxFalhas: num('NOTIFICACOES_WEBHOOK_MAX_FALHAS', 10),
  },
  /** Host base da plataforma para montar os deep links (dev: subdomínio.localhost). */
  hostPlataforma: process.env.NOTIFICACOES_HOST_PLATAFORMA ?? 'localhost:3000',
  concorrencia: num('NOTIFICACOES_CONCURRENCY', 5),
};

export type NotificacoesConfig = typeof notificacoesConfig;
