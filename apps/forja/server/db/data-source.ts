import 'reflect-metadata';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { ConfigForja } from '../config';
import { BancoForja } from './banco';
import { ENTIDADES } from './entidades';
import { ErroMigracao } from './erros';
import { relogioSistema, type Relogio } from './ids';
import { MIGRACOES } from './migrations';

/**
 * Abertura do SQLite da Forja (specs/forja/02 §1 e §7).
 *
 * - Um único processo escritor (o servidor, F-17) com `better-sqlite3`
 *   (síncrono). PRAGMAs na abertura: `journal_mode=WAL`, `foreign_keys=ON`,
 *   `busy_timeout=5000`, `synchronous=NORMAL`.
 * - `synchronize: false` SEMPRE: o schema é das migrations escritas à mão.
 * - Migrations no boot: se houver pendentes num banco que já existe, primeiro
 *   `VACUUM INTO '<dados>/backups/forja-<timestamp>.db'` (mantém 5); falhou →
 *   não sobe e o erro traz o caminho do backup. Cada migration roda na sua
 *   transação e termina com `PRAGMA foreign_key_check` (rollback se não vazio).
 * - Permissões: diretório de dados `0700`, `forja.db*` e backups `0600` — o
 *   arquivo é criado vazio com `0600` ANTES do SQLite abri-lo, e o SQLite cria
 *   `-wal`/`-shm` com as permissões do banco.
 */

export const NOME_ARQUIVO_BANCO = 'forja.db';
export const DIR_BACKUPS = 'backups';
export const BACKUPS_MANTIDOS = 5;
export const BUSY_TIMEOUT_MS = 5000;
export const TABELA_MIGRACOES = 'migracao';

export function caminhoBanco(dirDados: string): string {
  return join(dirDados, NOME_ARQUIVO_BANCO);
}

/** DataSource sem efeitos colaterais (não inicializa, não migra). */
export function criarDataSource(caminho: string): DataSource {
  return new DataSource({
    type: 'better-sqlite3',
    database: caminho,
    entities: ENTIDADES,
    migrations: MIGRACOES,
    migrationsTableName: TABELA_MIGRACOES,
    migrationsTransactionMode: 'each',
    synchronize: false,
    migrationsRun: false,
    enableWAL: true,
    timeout: BUSY_TIMEOUT_MS,
    logging: process.env.FORJA_DB_LOG === 'true',
    prepareDatabase: (db: { pragma(sql: string): unknown }) => {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.pragma('synchronous = NORMAL');
    },
  });
}

export interface OpcoesAbrirBanco {
  /** Aplica migrations pendentes (default true — o boot sempre aplica). */
  migrar?: boolean;
  relogio?: Relogio;
}

function garantirArquivoPrivado(caminho: string): void {
  if (!existsSync(caminho)) closeSync(openSync(caminho, 'a', 0o600));
  chmodSync(caminho, 0o600);
}

/** Banco "virgem" (acabou de ser criado) não precisa de backup antes de migrar. */
async function bancoTemDados(ds: DataSource): Promise<boolean> {
  const linhas = (await ds.query(
    `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  )) as { n: number }[];
  return (linhas[0]?.n ?? 0) > 0;
}

function carimbo(data: Date): string {
  return data.toISOString().replace(/[:.]/g, '-');
}

/** `VACUUM INTO` (cópia consistente mesmo com WAL) + rotação dos backups. */
export async function copiarParaBackup(
  ds: DataSource,
  dirDados: string,
  agora: Date,
): Promise<string> {
  const dir = join(dirDados, DIR_BACKUPS);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let destino = join(dir, `forja-${carimbo(agora)}.db`);
  for (let i = 1; existsSync(destino); i++) destino = join(dir, `forja-${carimbo(agora)}-${i}.db`);
  await ds.query(`VACUUM INTO ?`, [destino]);
  chmodSync(destino, 0o600);
  const antigos = readdirSync(dir)
    .filter((n) => /^forja-.*\.db$/.test(n))
    .sort();
  for (const nome of antigos.slice(0, Math.max(0, antigos.length - BACKUPS_MANTIDOS))) {
    rmSync(join(dir, nome), { force: true });
  }
  return destino;
}

export interface ResultadoMigracao {
  aplicadas: string[];
  backup: string | null;
}

/** Aplica as pendentes com backup antes (02 §1). Lança `ErroMigracao` com o caminho do backup. */
export async function migrarComBackup(
  ds: DataSource,
  dirDados: string,
  agora: Date,
): Promise<ResultadoMigracao> {
  // Antes do `showMigrations`, que cria a tabela de controle num banco vazio.
  const precisaBackup = await bancoTemDados(ds);
  const pendentes = await ds.showMigrations();
  if (!pendentes) return { aplicadas: [], backup: null };
  const backup = precisaBackup ? await copiarParaBackup(ds, dirDados, agora) : null;
  try {
    const aplicadas = await ds.runMigrations({ transaction: 'each' });
    const violacoes = (await ds.query('PRAGMA foreign_key_check')) as unknown[];
    if (violacoes.length > 0) {
      throw new Error(`foreign_key_check com ${violacoes.length} violação(ões) após as migrations`);
    }
    return { aplicadas: aplicadas.map((m) => m.name), backup };
  } catch (erro) {
    const onde = backup ? ` Backup anterior: ${backup}` : '';
    throw new ErroMigracao(
      `falha ao aplicar migrations: ${(erro as Error).message}.${onde}`,
      backup,
      erro,
    );
  }
}

/** Desfaz a última migration aplicada, com backup antes (script `migration:revert`). */
export async function reverterUltima(
  ds: DataSource,
  dirDados: string,
  agora: Date,
): Promise<{ backup: string }> {
  const backup = await copiarParaBackup(ds, dirDados, agora);
  await ds.undoLastMigration({ transaction: 'each' });
  return { backup };
}

/**
 * Abre `<dados>/forja.db`, aplica as migrations pendentes e devolve o
 * `BancoForja` pronto (é o passo "SQLite/migrations" do boot, 01 §4.1).
 * Em falha de migration o DataSource é fechado e o erro é `ErroMigracao`.
 */
export async function abrirBanco(
  config: Pick<ConfigForja, 'dirDados'>,
  opcoes: OpcoesAbrirBanco = {},
): Promise<BancoForja> {
  const relogio = opcoes.relogio ?? relogioSistema;
  mkdirSync(config.dirDados, { recursive: true, mode: 0o700 });
  const caminho = caminhoBanco(config.dirDados);
  garantirArquivoPrivado(caminho);

  const ds = criarDataSource(caminho);
  await ds.initialize();
  let migracao: ResultadoMigracao = { aplicadas: [], backup: null };
  if (opcoes.migrar ?? true) {
    try {
      migracao = await migrarComBackup(ds, config.dirDados, relogio());
    } catch (erro) {
      await ds.destroy();
      throw erro;
    }
  }
  return new BancoForja(ds, { caminho, relogio, migracao });
}
