import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from './perfis';

/**
 * Onde estão o servidor MCP do Chamados e o utilitário de prints que os
 * agentes recebem (FJ-030 §3, §4).
 *
 * POR QUE o `apps/mcp` do monorepo e não um pacote instalado: é o mesmo MCP
 * que o usuário já usa "com o claude diretamente" (o pedido que originou a
 * FJ-030); a Forja só o liga em modo somente leitura e com o token da própria
 * conexão. `FORJA_MCP_CHAMADOS` aponta para outro `index.ts` se o layout mudar.
 */

/** `apps/forja` (este arquivo fica em `apps/forja/server/claude/`). */
const RAIZ_APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Caminho absoluto de `server/scripts/forja-print.mjs` (B7, env `FORJA_PRINT`). */
export function caminhoForjaPrint(): string {
  return join(RAIZ_APP, 'server', 'scripts', 'forja-print.mjs');
}

/** `node_modules/.bin/tsx` mais próximo subindo a partir de `apps/forja`. */
function localizarTsx(inicio: string): string | null {
  let dir = inicio;
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(bin)) return bin;
    const pai = dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

export interface ServidorMcp {
  command: string;
  args: string[];
  /** O `index.ts` usado (exibido no Diagnóstico). */
  entrada: string;
}

/**
 * `tsx <apps/mcp/src/index.ts>` (FJ-030 §4). `null` quando a entrada não existe:
 * os agentes rodam sem MCP e o Diagnóstico explica por quê.
 */
export function localizarServidorMcp(env: Env = process.env): ServidorMcp | null {
  const entrada = env.FORJA_MCP_CHAMADOS?.trim() || join(RAIZ_APP, '..', 'mcp', 'src', 'index.ts');
  if (!existsSync(entrada)) return null;
  const tsx = localizarTsx(RAIZ_APP);
  return tsx
    ? { command: tsx, args: [entrada], entrada }
    : { command: 'npx', args: ['--no-install', 'tsx', entrada], entrada };
}
