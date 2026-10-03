import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Testes unitários do monorepo (vitest). Cobre lógica pura testável sem infra:
 * a matriz de autorização e os serializers do papel cliente (packages/shared).
 * Testes que exigem banco (isolamento RLS, fluxo de auth) rodam como smoke
 * scripts contra o Postgres em Docker: `npm run smoke:rls` / `npm run smoke:auth`.
 */
export default defineConfig({
  resolve: {
    // Alias da SPA da Forja (apps/forja/web/tsconfig.json) para os testes de web/src/lib.
    alias: { '@comum': fileURLToPath(new URL('./apps/forja/comum', import.meta.url)) },
  },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'apps/mcp/src/**/*.test.ts',
      // Forja (specs/forja/01 §4.2): só lógica pura; nenhum teste chama o `claude` real.
      'apps/forja/server/**/*.test.ts',
      'apps/forja/comum/**/*.test.ts',
      'apps/forja/web/src/**/*.test.ts',
    ],
    environment: 'node',
  },
});
