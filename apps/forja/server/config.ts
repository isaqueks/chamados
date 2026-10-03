import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModoForja } from '../comum/estados';

/**
 * Configuração do processo local da Forja (specs/forja/01 §12, 05 §7.1, 02 §7).
 *
 * POR QUE quase nada é configurável: a Forja é local e single-user. O bind é
 * SEMPRE `127.0.0.1` (nunca `0.0.0.0` — a máquina tem várias portas abertas em
 * todas as interfaces, 05 §7.1); só a porta muda. O modo `dev` (via
 * `FORJA_MODO=dev`, posto pelo script `dev`) muda duas coisas: aceita a origem do
 * Vite (`5173`) e usa outro diretório de dados (`forja-dev/`), para o
 * desenvolvimento nunca tocar no banco de uso real.
 */

export const PORTA_PADRAO = 4317;
export const PORTA_VITE_DEV = 5173;
export const HOST_BIND = '127.0.0.1';

export interface ConfigForja {
  modo: ModoForja;
  host: typeof HOST_BIND;
  porta: number;
  /** Raiz do diretório de dados (0700), nunca dentro de um repositório (02 §7). */
  dirDados: string;
  /** Build da SPA servido pelo Fastify em produção. */
  dirWebDist: string;
  /** Versão do app (package.json), exibida no shell. */
  versao: string;
}

export class ErroConfig extends Error {}

type Env = Record<string, string | undefined>;

export function lerModo(env: Env): ModoForja {
  const v = env.FORJA_MODO?.trim();
  if (!v || v === 'producao') return 'producao';
  if (v === 'dev') return 'dev';
  throw new ErroConfig(`FORJA_MODO inválido: "${v}" (use "dev" ou omita)`);
}

export function lerPorta(env: Env): number {
  const v = env.FORJA_PORTA?.trim();
  if (!v) return PORTA_PADRAO;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new ErroConfig(`FORJA_PORTA inválida: "${v}" (inteiro entre 1024 e 65535)`);
  }
  return n;
}

/**
 * `${FORJA_DADOS_DIR}` ou `${XDG_DATA_HOME:-~/.local/share}/forja[-dev]/` (01 §12, 02 §7).
 * Caminho relativo é recusado: o diretório de dados não pode depender do cwd.
 */
export function resolverDirDados(env: Env, modo: ModoForja, home: string = homedir()): string {
  const explicito = env.FORJA_DADOS_DIR?.trim();
  if (explicito) {
    if (!explicito.startsWith('/')) {
      throw new ErroConfig(`FORJA_DADOS_DIR precisa ser absoluto: "${explicito}"`);
    }
    return resolve(explicito);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.startsWith('/') ? xdg : join(home, '.local', 'share');
  return join(base, modo === 'dev' ? 'forja-dev' : 'forja');
}

const RAIZ_APP = fileURLToPath(new URL('..', import.meta.url));

export function carregarConfig(env: Env = process.env, versao = '0.0.0'): ConfigForja {
  const modo = lerModo(env);
  return {
    modo,
    host: HOST_BIND,
    porta: lerPorta(env),
    dirDados: resolverDirDados(env, modo),
    dirWebDist: join(RAIZ_APP, 'web', 'dist'),
    versao,
  };
}
