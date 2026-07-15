/**
 * Configuração de conexão ao PostgreSQL, lida de variáveis de ambiente com
 * defaults que batem com o docker-compose.yml. Assim a aplicação sobe em dev
 * mesmo sem `.env`.
 *
 * São DOIS conjuntos de credenciais:
 *  - admin  (POSTGRES_USER): superuser do container, roda migrations, BYPASSRLS.
 *  - app    (APP_DB_USER):   role da aplicação, SEM BYPASSRLS — sempre sob RLS.
 */

function env(nome: string, padrao: string): string {
  const v = process.env[nome];
  return v === undefined || v === '' ? padrao : v;
}

export interface ConexaoBase {
  host: string;
  port: number;
  database: string;
}

export const conexaoBase: ConexaoBase = {
  host: env('POSTGRES_HOST', 'localhost'),
  port: Number(env('POSTGRES_PORT', '5432')),
  database: env('POSTGRES_DB', 'chamados'),
};

/** Credenciais administrativas (migrations/tarefas). Têm BYPASSRLS. */
export const credenciaisAdmin = {
  username: env('POSTGRES_USER', 'chamados'),
  password: env('POSTGRES_PASSWORD', 'chamados'),
};

/** Credenciais da aplicação (web/worker). Role SEM BYPASSRLS. */
export const credenciaisApp = {
  username: env('APP_DB_USER', 'chamados_app'),
  password: env('APP_DB_PASSWORD', 'chamados_app'),
};
