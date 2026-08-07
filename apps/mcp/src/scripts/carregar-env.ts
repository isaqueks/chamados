import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Carrega o `.env` da raiz do monorepo (se existir), independentemente do cwd de
 * onde o script foi disparado. Mesmo helper de `packages/db` e `apps/worker` —
 * o servidor MCP em si NÃO usa isto (recebe as variáveis do cliente MCP); só os
 * scripts de smoke, que precisam falar com o banco.
 */
export function carregarEnvRaiz(): void {
  const aqui = dirname(fileURLToPath(import.meta.url)); // apps/mcp/src/scripts
  const raiz = resolve(aqui, '../../../..'); // -> raiz do repo
  const envPath = resolve(raiz, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }
}
