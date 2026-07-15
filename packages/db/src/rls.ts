import type { DataSource, EntityManager } from 'typeorm';

/**
 * Executa `fn` dentro de uma transação com o tenant corrente definido em
 * escopo LOCAL (`SET LOCAL app.current_tenant`). É o ÚNICO ponto por onde o
 * acesso a dados de negócio da aplicação deve passar.
 *
 * Por que transação + LOCAL: num pool de conexões, um `SET` de sessão vazaria
 * o tenant para a próxima requisição que reutilizasse a conexão. `set_config
 * (..., true)` (3º arg = local) garante que o valor morre no fim da transação.
 * A RLS lê exatamente `app.current_tenant`.
 *
 * @param ds DataSource da aplicação (role SEM BYPASSRLS).
 * @param tenantId UUID do tenant corrente.
 * @param fn Recebe o EntityManager transacional já escopado ao tenant.
 */
export async function runInTenantContext<T>(
  ds: DataSource,
  tenantId: string,
  fn: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return ds.transaction(async (em) => {
    // Parametrizado (evita injeção) e local à transação (3º arg = true).
    await em.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    return fn(em);
  });
}
