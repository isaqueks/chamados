import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { ambienteTemporario, relogioDeTeste, semear, type Ambiente } from './apoio-testes';
import {
  abrirBanco,
  BACKUPS_MANTIDOS,
  copiarParaBackup,
  migrarComBackup,
  reverterUltima,
  TABELA_MIGRACOES,
} from './data-source';
import { ENTIDADES } from './entidades';
import { ErroMigracao } from './erros';
import { novoId } from './ids';
import { MIGRACOES } from './migrations';

let amb: Ambiente | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await amb?.limpar();
  amb = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dirTemporario(): string {
  const d = mkdtempSync(join(tmpdir(), 'forja-ds-'));
  dirs.push(d);
  return d;
}

describe('abrirBanco (02 §1)', () => {
  it('cria forja.db 0600, aplica as migrations e liga os PRAGMAs', async () => {
    amb = await ambienteTemporario();
    const { banco, dir } = amb;
    expect(banco.migracao.aplicadas).toEqual([
      'Init1790000000000',
      'RemotoUrl1790000000001',
      'ProjetoV21790000000002',
      'Fj032VerificacaoPeloAgente1790000000003',
    ]);
    expect(banco.migracao.backup).toBeNull();
    expect(statSync(join(dir, 'forja.db')).mode & 0o777).toBe(0o600);

    const pragma = async (p: string) =>
      Object.values(((await banco.ds.query(`PRAGMA ${p}`)) as Record<string, unknown>[])[0]!)[0];
    expect(await pragma('journal_mode')).toBe('wal');
    expect(await pragma('foreign_keys')).toBe(1);
    expect(await pragma('busy_timeout')).toBe(5000);
    expect(await pragma('synchronous')).toBe(1);
  });

  it('reabrir sem migration pendente não faz backup', async () => {
    const dir = dirTemporario();
    const b1 = await abrirBanco({ dirDados: dir });
    await b1.fechar();
    const b2 = await abrirBanco({ dirDados: dir });
    expect(b2.migracao).toEqual({ aplicadas: [], backup: null });
    await b2.fechar();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('migration pendente num banco existente: VACUUM INTO antes de migrar', async () => {
    const dir = dirTemporario();
    const b1 = await abrirBanco({ dirDados: dir });
    const { backup: backupRevert } = await reverterUltima(b1.ds, dir, new Date());
    expect(existsSync(backupRevert)).toBe(true);
    await b1.fechar();

    const b2 = await abrirBanco({ dirDados: dir }, { relogio: relogioDeTeste() });
    // Reverteu só a última: só ela volta a ser aplicada.
    expect(b2.migracao.aplicadas).toEqual(['Fj032VerificacaoPeloAgente1790000000003']);
    expect(b2.migracao.backup).toMatch(/backups\/forja-2026-10-02T12-00-00-000Z\.db$/);
    expect(statSync(b2.migracao.backup!).mode & 0o777).toBe(0o600);
    await b2.fechar();
  });

  it(`mantém só os ${BACKUPS_MANTIDOS} backups mais recentes`, async () => {
    amb = await ambienteTemporario();
    for (let i = 0; i < BACKUPS_MANTIDOS + 2; i++) {
      await copiarParaBackup(amb.banco.ds, amb.dir, new Date(Date.UTC(2026, 9, 2, 12, 0, i)));
    }
    const nomes = readdirSync(join(amb.dir, 'backups')).sort();
    expect(nomes).toHaveLength(BACKUPS_MANTIDOS);
    expect(nomes[0]).toBe('forja-2026-10-02T12-00-02-000Z.db');
  });

  it('falha de migration: ErroMigracao com o backup e a migration desfeita', async () => {
    const dir = dirTemporario();
    await (await abrirBanco({ dirDados: dir })).fechar();

    class Quebrada1790000099999 implements MigrationInterface {
      name = 'Quebrada1790000099999';
      async up(qr: QueryRunner): Promise<void> {
        await qr.query('CREATE TABLE "temporaria" ("x" INTEGER)');
        await qr.query('SELECT * FROM "tabela_que_nao_existe"');
      }
      async down(): Promise<void> {}
    }
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: join(dir, 'forja.db'),
      entities: ENTIDADES,
      migrations: [...MIGRACOES, Quebrada1790000099999],
      migrationsTableName: TABELA_MIGRACOES,
    });
    await ds.initialize();
    const erro = await migrarComBackup(ds, dir, new Date()).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroMigracao);
    expect((erro as ErroMigracao).caminhoBackup).toMatch(/backups\/forja-.*\.db$/);
    const temporaria = (await ds.query(
      `SELECT name FROM sqlite_master WHERE name = 'temporaria'`,
    )) as unknown[];
    expect(temporaria).toHaveLength(0);
    await ds.destroy();
  });
});

describe('entidades × migration', () => {
  it('cada entidade bate com a tabela: colunas, nulidade, índices e CHECKs nomeados', async () => {
    amb = await ambienteTemporario();
    const ds = amb.banco.ds;
    for (const meta of ds.entityMetadatas) {
      const info = (await ds.query(`PRAGMA table_info("${meta.tableName}")`)) as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const noBanco = new Map(info.map((c) => [c.name, c]));
      const naEntidade = meta.columns.map((c) => c.databaseName).sort();
      expect([...noBanco.keys()].sort(), meta.tableName).toEqual(naEntidade);
      for (const c of meta.columns) {
        const col = noBanco.get(c.databaseName)!;
        expect(col.notnull === 1 || col.pk === 1, `${meta.tableName}.${c.databaseName}`).toBe(
          !c.isNullable,
        );
      }
      const indices = (
        (await ds.query(`PRAGMA index_list("${meta.tableName}")`)) as { name: string }[]
      ).map((i) => i.name);
      for (const i of meta.indices) {
        if (i.name) expect(indices, `${meta.tableName}`).toContain(i.name);
      }
      const [{ sql }] = (await ds.query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [meta.tableName],
      )) as [{ sql: string }];
      for (const ck of meta.checks) expect(sql, meta.tableName).toContain(`"${ck.name}"`);
      for (const u of meta.uniques) {
        if (u.name) expect(sql, meta.tableName).toContain(`"${u.name}"`);
      }
    }
    expect(ds.entityMetadatas).toHaveLength(15);
  });

  it('evento.seq é AUTOINCREMENT (nunca reutiliza o maior seq apagado)', async () => {
    amb = await ambienteTemporario();
    const [{ sql }] = (await amb.banco.ds.query(
      `SELECT sql FROM sqlite_master WHERE name = 'evento'`,
    )) as [{ sql: string }];
    expect(sql).toMatch(/"seq" INTEGER PRIMARY KEY AUTOINCREMENT/);
  });

  it('revert do init remove todas as tabelas mesmo com dados (FK circular execução ⇄ aprovação)', async () => {
    amb = await ambienteTemporario();
    const s = await semear(amb.banco);
    await amb.banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: s.execucao.id,
        tipo: 'final',
        decisao: 'aprovado',
        patch_id: 'p1',
        sha: 'a'.repeat(40),
      }),
    );
    // Desfaz todas, da última ao init.
    for (let i = 0; i < MIGRACOES.length; i++) {
      await amb.banco.ds.undoLastMigration({ transaction: 'each' });
    }
    const tabelas = (await amb.banco.ds.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )) as { name: string }[];
    expect(tabelas.map((t) => t.name)).toEqual([TABELA_MIGRACOES]);
  });
});

describe('projeto v2 (FJ-030 §1)', () => {
  it('v1 → v2 sem perder projeto: o que não é básico vai para `avancado`; sistemas mapeados viram explícitos', async () => {
    amb = await ambienteTemporario();
    const s = await semear(amb.banco);
    await amb.banco.transacao((r) =>
      r.projetos.definirSistemas(s.projetoId, [{ sistema_nome: 'ERP' }]),
    );
    // Volta à v1 (colunas resolvidas) e reaplica a migration (a 0003 sai antes).
    await amb.banco.ds.undoLastMigration({ transaction: 'each' });
    await amb.banco.ds.undoLastMigration({ transaction: 'each' });
    const [v1] = (await amb.banco.ds.query(
      `SELECT "remoto", "branch_destino", "entrega", "comandos", "evidencias" FROM "projeto"`,
    )) as { remoto: string; branch_destino: string; entrega: string; comandos: string }[];
    expect(v1).toMatchObject({ remoto: 'origin', branch_destino: 'main' });
    await amb.banco.ds.query(
      `UPDATE "projeto" SET "comandos" = ?, "gates" = json_set("gates", '$.plano', 'sempre')`,
      [
        JSON.stringify({
          dependencias: 'instalar',
          setup: { comando: 'npm ci', timeout_s: 900 },
          verificacao: [{ nome: 'lint', comando: 'npm run lint', timeout_s: 60 }],
          e2e: null,
          app_subir: null,
          healthcheck: null,
        }),
      ],
    );
    await amb.banco.ds.runMigrations({ transaction: 'each' });
    const p = await amb.banco.ler((r) => r.projetos.exigir(s.projetoId));
    expect(p.config_versao).toBe(2);
    expect(p.branch_destino).toBe('main');
    expect(p.sistemas).toEqual(['ERP']);
    expect(p.avancado?.comandos?.verificacao).toEqual([
      { nome: 'lint', comando: 'npm run lint', timeout_s: 60 },
    ]);
    expect(p.avancado?.gates).toEqual({ plano: 'sempre' });
    // A execução semeada continua apontando para o projeto (FK conferida).
    const e = await amb.banco.ler((r) => r.execucoes.exigir(s.execucao.id));
    expect(e.projeto_id).toBe(s.projetoId);
  });
});

describe('FJ-032: verificação pelo agente (migration 0003)', () => {
  const ddlExecucao = async (a: Ambiente) =>
    (
      (await a.banco.ds.query(
        `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'execucao'`,
      )) as { sql: string }[]
    )[0]!.sql;

  it('níveis novos no CHECK sem cascata nas filhas; execuções presas em base_vermelha voltam a andar', async () => {
    amb = await ambienteTemporario();
    const a = amb;
    const s = await semear(a.banco);
    const outra = await semear(a.banco, 43);
    // Volta ao estado anterior a FJ-032: CHECK antigo e execuções presas na linha de base.
    await a.banco.ds.undoLastMigration({ transaction: 'each' });
    expect(await ddlExecucao(a)).not.toContain('verificado_pelo_revisor');
    await expect(
      a.banco.ds.query(`UPDATE "execucao" SET "nivel_verificacao" = 'declarado' WHERE "id" = ?`, [
        s.execucao.id,
      ]),
    ).rejects.toThrow(/CHECK/);
    await a.banco.ds.query(
      `UPDATE "execucao" SET "estado" = 'precisa_humano', "estado_anterior" = NULL,
         "motivo_estado" = 'base_vermelha', "motivo_texto" = 'o destino já falha em typecheck, unit'
       WHERE "id" IN (?, ?)`,
      [s.execucao.id, outra.execucao.id],
    );
    // Uma delas já tinha plano: volta a `plano_pronto`; a outra replaneja.
    await a.banco.transacao((r) =>
      r.artefatos.criar({
        execucao_id: outra.execucao.id,
        tipo: 'plano',
        contrato: 'plano.v1',
        conteudo: { versao: 1 },
      }),
    );
    await a.banco.ds.query(
      `INSERT INTO "evento" ("execucao_id", "origem", "tipo", "nivel", "resumo", "criado_em")
       VALUES (?, 'app', 'cli.alerta', 'info', 'filha antiga', '2026-10-01T00:00:00.000Z')`,
      [s.execucao.id],
    );
    const filhas = async () =>
      (
        (await a.banco.ds.query(
          `SELECT COUNT(*) AS n FROM "evento" WHERE "resumo" = 'filha antiga'`,
        )) as {
          n: number;
        }[]
      )[0]!.n;
    expect(await filhas()).toBe(1);

    await a.banco.ds.runMigrations({ transaction: 'each' });

    expect(await ddlExecucao(a)).toContain("'verificado_pelo_revisor'");
    expect(await filhas()).toBe(1);
    const pragma = (await a.banco.ds.query('PRAGMA foreign_keys')) as { foreign_keys: number }[];
    expect(pragma[0]!.foreign_keys).toBe(1);
    const e = await a.banco.ler((r) => r.execucoes.exigir(s.execucao.id));
    expect(e).toMatchObject({ estado: 'planejando', motivo_estado: null, estado_anterior: null });
    expect(e.motivo_texto).toContain('FJ-032');
    expect(e.motivo_texto).toContain('o destino já falha em typecheck, unit');
    const o = await a.banco.ler((r) => r.execucoes.exigir(outra.execucao.id));
    expect(o.estado).toBe('plano_pronto');
    await a.banco.transacao((r) =>
      r.execucoes.atualizar(s.execucao.id, { nivel_verificacao: 'verificado_pelo_revisor' }),
    );
    const eventos = (await a.banco.ds.query(
      `SELECT "resumo" FROM "evento" WHERE "execucao_id" = ? AND "tipo" = 'execucao.estado'`,
      [s.execucao.id],
    )) as { resumo: string }[];
    expect(eventos.at(-1)?.resumo).toContain('precisa_humano → planejando');
  });
});

describe('novoId (UUID v7)', () => {
  it('versão 7, variante RFC 9562 e ordenável por tempo', () => {
    const a = novoId(Date.UTC(2026, 0, 1));
    const b = novoId(Date.UTC(2026, 0, 2));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    const lote = Array.from({ length: 200 }, () => novoId(Date.UTC(2026, 0, 3)));
    expect([...lote].sort()).toEqual(lote);
    expect(new Set(lote).size).toBe(lote.length);
  });
});
