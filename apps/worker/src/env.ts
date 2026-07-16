import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Carrega o `.env` da RAIZ do monorepo ao subir o worker, independentemente do
 * cwd (o `npm run dev:worker` roda com cwd em `apps/worker`, onde não há `.env`).
 * Deve ser o PRIMEIRO import do entrypoint: os módulos de config leem
 * `process.env` no momento do import. O dotenv nunca sobrescreve variáveis já
 * presentes no ambiente do processo. Mesmo padrão de `packages/db/src/scripts/
 * carregar-env.ts` e do `apps/web/next.config.ts`.
 */
const aqui = dirname(fileURLToPath(import.meta.url)); // apps/worker/src
const envPath = resolve(aqui, '../../..', '.env'); // -> raiz do repo
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}
