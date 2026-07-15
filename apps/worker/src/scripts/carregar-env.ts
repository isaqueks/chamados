import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Carrega o `.env` da raiz do monorepo (se existir), independentemente do cwd.
 * Sem `.env`, os defaults do código assumem (dev bate com o docker-compose).
 */
export function carregarEnvRaiz(): void {
  const aqui = dirname(fileURLToPath(import.meta.url)); // apps/worker/src/scripts
  const raiz = resolve(aqui, '../../../..'); // -> raiz do repo
  const envPath = resolve(raiz, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }
}
