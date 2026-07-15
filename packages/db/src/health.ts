import { obterAppDataSource } from './data-source';

/**
 * Verifica a conectividade com o PostgreSQL usando o DataSource da aplicação.
 * Roda um `SELECT 1` fora de contexto de tenant (não toca tabelas com RLS).
 */
export async function verificarPostgres(): Promise<boolean> {
  try {
    const ds = await obterAppDataSource();
    await ds.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
