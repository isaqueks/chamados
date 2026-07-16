import pg from 'pg';
import mysql from 'mysql2/promise';
import type { Linha } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';

/**
 * Ferramenta BD (read-only, specs/05 §4.2, specs/09 §4.2). Conexão DEDICADA ao
 * banco do sistema-alvo (bd_tipo/host/porta/nome + credencial decifrada do
 * cofre), criada de forma preguiçosa e fechada no fim do job. SGBDs suportados:
 * **postgres** (default) e **mysql/mariadb** (mysql2 — tarefa #14: o driver pg
 * contra um MySQL falhava com "received invalid response: 5b"). Toda consulta:
 *  1. é VALIDADA antes de executar — só `SELECT`/`WITH`, sem múltiplas
 *     instruções, sem palavras de escrita/DDL (INSERT/UPDATE/DELETE/DDL
 *     rejeitados ANTES de tocar o banco);
 *  2. roda em modo `READ ONLY` com timeout curto de statement (defesa em
 *     profundidade: mesmo que a validação falhasse, o banco recusa a escrita);
 *  3. tem LIMIT FORÇADO (nunca despeja tabelas inteiras).
 *
 * A credencial NUNCA é logada; o handle exposto ao provider é só uma função.
 */

const { Pool } = pg;

export interface ConfigBd {
  tipo: string | null;
  host: string | null;
  porta: number | null;
  nome: string | null;
  /** Credencial decifrada: "user:password", URI ("postgres://", "mysql://") ou só password. */
  credencial: string | null;
}

/** Palavras de escrita/DDL proibidas (defesa extra além do READ ONLY). */
const PROIBIDAS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|do|vacuum|reindex|comment|lock|set|reset|begin|commit|rollback|savepoint)\b/i;

/**
 * Valida e normaliza a consulta (SELECT/WITH only). Lança com motivo claro para
 * o modelo entender por que a ação foi negada. Remove `;` final; múltiplas
 * instruções (`;` interno) são rejeitadas (evita statement stacking).
 */
export function validarConsulta(sql: string): string {
  const limpo = sql.trim().replace(/;\s*$/, '').trim();
  if (limpo.length === 0) throw new Error('consulta vazia');
  if (limpo.includes(';')) {
    throw new Error('múltiplas instruções não são permitidas (apenas um SELECT)');
  }
  // Ignora comentários/espaços iniciais para achar a 1ª palavra-chave.
  const semComentario = limpo.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  if (!/^(select|with)\b/i.test(semComentario)) {
    throw new Error('apenas consultas SELECT/WITH são permitidas (acesso read-only)');
  }
  if (PROIBIDAS.test(limpo)) {
    throw new Error('comando de escrita/DDL rejeitado (acesso read-only)');
  }
  return limpo;
}

/** `true` quando o bd_tipo do sistema-alvo pede o driver MySQL (mysql/mariadb). */
export function ehMysql(tipo: string | null): boolean {
  return /^(mysql|mariadb)$/i.test((tipo ?? '').trim());
}

/** Divide a credencial "user:password" (ou só password). */
function credencialUserSenha(cred: string): { user?: string; password?: string } {
  const idx = cred.indexOf(':');
  return {
    user: idx >= 0 ? cred.slice(0, idx) : undefined,
    password: idx >= 0 ? cred.slice(idx + 1) : cred || undefined,
  };
}

function exigirConexao(cfg: ConfigBd): void {
  if (!cfg.host || !cfg.nome) {
    throw new Error('conexão de BD do sistema-alvo não configurada');
  }
}

/** Executor por SGBD: mesma semântica (read-only + timeout + LIMIT forçado). */
interface ExecutorBd {
  consultar(consulta: string, maxLinhas: number): Promise<Linha[]>;
  encerrar(): Promise<void>;
}

// ---------------------------------------------------------------- PostgreSQL

function criarExecutorPg(cfg: ConfigBd): ExecutorBd {
  const { statementTimeoutMs } = ferramentasConfig.bd;
  let pool: pg.Pool | null = null;

  const obterPool = (): pg.Pool => {
    if (pool) return pool;
    exigirConexao(cfg);
    const cred = cfg.credencial ?? '';
    const base: pg.PoolConfig = {
      max: 2,
      connectionTimeoutMillis: ferramentasConfig.bd.conexaoTimeoutMs,
      idleTimeoutMillis: 10_000,
    };
    pool =
      cred.startsWith('postgres://') || cred.startsWith('postgresql://')
        ? new Pool({ ...base, connectionString: cred })
        : new Pool({
            ...base,
            host: cfg.host ?? undefined,
            port: cfg.porta ?? 5432,
            database: cfg.nome ?? undefined,
            ...credencialUserSenha(cred),
          });
    return pool;
  };

  return {
    async consultar(consulta, maxLinhas) {
      const client = await obterPool().connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${Number(statementTimeoutMs)}`);
        // LIMIT forçado por envelope: cap independente do que a consulta pediu.
        const res = await client.query(`SELECT * FROM (${consulta}) AS _lim LIMIT ${maxLinhas}`);
        await client.query('ROLLBACK'); // read-only: nada a persistir
        return res.rows as Linha[];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err instanceof Error ? new Error(err.message) : err;
      } finally {
        client.release();
      }
    },
    async encerrar() {
      if (pool) {
        await pool.end().catch(() => {});
        pool = null;
      }
    },
  };
}

// ------------------------------------------------------------- MySQL/MariaDB

function criarExecutorMysql(cfg: ConfigBd): ExecutorBd {
  const { statementTimeoutMs } = ferramentasConfig.bd;
  let pool: mysql.Pool | null = null;

  const obterPool = (): mysql.Pool => {
    if (pool) return pool;
    exigirConexao(cfg);
    const cred = cfg.credencial ?? '';
    pool = cred.startsWith('mysql://')
      ? mysql.createPool(cred)
      : mysql.createPool({
          host: cfg.host ?? undefined,
          port: cfg.porta ?? 3306,
          database: cfg.nome ?? undefined,
          ...credencialUserSenha(cred),
          connectionLimit: 2,
          connectTimeout: ferramentasConfig.bd.conexaoTimeoutMs,
        });
    return pool;
  };

  return {
    async consultar(consulta, maxLinhas) {
      const conn = await obterPool().getConnection();
      try {
        // Sessão READ ONLY: escrita falha no servidor (ERROR 1792) mesmo que a
        // validação léxica falhasse. MAX_EXECUTION_TIME (ms) corta SELECTs longos.
        await conn.query('SET SESSION TRANSACTION READ ONLY');
        try {
          await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Number(statementTimeoutMs)}`);
        } catch {
          // MariaDB usa max_statement_time (em SEGUNDOS). Best-effort: o hard
          // guarantee do read-only não depende do timeout.
          await conn
            .query(`SET SESSION max_statement_time = ${Number(statementTimeoutMs) / 1000}`)
            .catch(() => {});
        }
        const [rows] = await conn.query(`SELECT * FROM (${consulta}) AS _lim LIMIT ${maxLinhas}`);
        return rows as Linha[];
      } catch (err) {
        throw err instanceof Error ? new Error(err.message) : err;
      } finally {
        conn.release();
      }
    },
    async encerrar() {
      if (pool) {
        await pool.end().catch(() => {});
        pool = null;
      }
    },
  };
}

// ------------------------------------------------------------------- Fachada

export interface FerramentaBd {
  bd_consultar(sql: string): Promise<Linha[]>;
  encerrar(): Promise<void>;
}

/** Cria o handle `bd_consultar` + o `encerrar()` que fecha o pool ao fim do job. */
export function criarFerramentaBd(cfg: ConfigBd, registrar: Registrar): FerramentaBd {
  const { maxLinhas } = ferramentasConfig.bd;
  const executor = ehMysql(cfg.tipo) ? criarExecutorMysql(cfg) : criarExecutorPg(cfg);

  return {
    async bd_consultar(sql) {
      // registrar SEM segredos: apenas o SQL solicitado.
      registrar('bd_consultar', { sql });
      const consulta = validarConsulta(sql); // lança ANTES de conectar
      return executor.consultar(consulta, maxLinhas);
    },
    encerrar: () => executor.encerrar(),
  };
}
