import pg from 'pg';
import type { Linha } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';

/**
 * Ferramenta BD (read-only, specs/05 §4.2, specs/09 §4.2). Conexão pg DEDICADA
 * ao banco do sistema-alvo (bd_host/porta/nome + credencial decifrada do cofre),
 * criada de forma preguiçosa e fechada no fim do job. Toda consulta:
 *  1. é VALIDADA antes de executar — só `SELECT`/`WITH`, sem múltiplas
 *     instruções, sem palavras de escrita/DDL (INSERT/UPDATE/DELETE/DDL
 *     rejeitados ANTES de tocar o banco);
 *  2. roda numa TRANSAÇÃO `READ ONLY` com `statement_timeout` curto (defesa em
 *     profundidade: mesmo que a validação falhasse, o banco recusa a escrita);
 *  3. tem LIMIT FORÇADO (nunca despeja tabelas inteiras).
 *
 * A credencial NUNCA é logada; o handle exposto ao provider é só uma função.
 */

const { Pool } = pg;
type PgPool = pg.Pool;

export interface ConfigBd {
  tipo: string | null;
  host: string | null;
  porta: number | null;
  nome: string | null;
  /** Credencial decifrada: "user:password", "postgres://..." ou só password. */
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

/** Monta a config do Pool a partir da credencial (várias formas suportadas). */
function configPool(cfg: ConfigBd): pg.PoolConfig {
  if (!cfg.host || !cfg.nome) {
    throw new Error('conexão de BD do sistema-alvo não configurada');
  }
  const cred = cfg.credencial ?? '';
  const base: pg.PoolConfig = {
    max: 2,
    connectionTimeoutMillis: ferramentasConfig.bd.conexaoTimeoutMs,
    idleTimeoutMillis: 10_000,
  };
  if (cred.startsWith('postgres://') || cred.startsWith('postgresql://')) {
    return { ...base, connectionString: cred };
  }
  const idx = cred.indexOf(':');
  const user = idx >= 0 ? cred.slice(0, idx) : undefined;
  const password = idx >= 0 ? cred.slice(idx + 1) : cred || undefined;
  return {
    ...base,
    host: cfg.host,
    port: cfg.porta ?? 5432,
    database: cfg.nome,
    user,
    password,
  };
}

export interface FerramentaBd {
  bd_consultar(sql: string): Promise<Linha[]>;
  encerrar(): Promise<void>;
}

/** Cria o handle `bd_consultar` + o `encerrar()` que fecha o pool ao fim do job. */
export function criarFerramentaBd(cfg: ConfigBd, registrar: Registrar): FerramentaBd {
  let pool: PgPool | null = null;
  const { statementTimeoutMs, maxLinhas } = ferramentasConfig.bd;

  const obterPool = (): PgPool => {
    if (!pool) pool = new Pool(configPool(cfg));
    return pool;
  };

  return {
    async bd_consultar(sql) {
      // registrar SEM segredos: apenas o SQL solicitado.
      registrar('bd_consultar', { sql });
      const consulta = validarConsulta(sql); // lança ANTES de conectar

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
