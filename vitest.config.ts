import { defineConfig } from 'vitest/config';

/**
 * Testes unitários do monorepo (vitest). Cobre lógica pura testável sem infra:
 * a matriz de autorização e os serializers do papel cliente (packages/shared).
 * Testes que exigem banco (isolamento RLS, fluxo de auth) rodam como smoke
 * scripts contra o Postgres em Docker: `npm run smoke:rls` / `npm run smoke:auth`.
 */
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
