/**
 * `@chamados/cliente-api` — cliente HTTP tipado da API `/api/v1` do Chamados,
 * compartilhado por `apps/mcp` e `apps/forja` (specs/forja/01 §5.2, FJ-023).
 * Zero dependência de runtime: usa o `fetch` global do Node 22.
 */
export * from './cliente';
export * from './erros';
export * from './armazenamento-token';
export * from './url-base';
export type * from './tipos';
