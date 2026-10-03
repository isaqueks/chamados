import type { MigrationInterface, QueryRunner } from 'typeorm';
import { NivelVerificacao } from '../../../comum/estados';
import { checkEnum, valoresDe } from '../sql';
import { conferirChavesEstrangeiras } from './util';

/**
 * FJ-032 (specs/forja/decisoes.md; 02 §1): a Forja não executa mais comandos do
 * projeto — quem roda os checks é o agente, e o nível ⚙ sai do que o revisor
 * relatou × o stream do T2.
 *
 * 1. `execucao.nivel_verificacao` passa a aceitar `verificado_pelo_revisor` e
 *    `declarado` (os níveis antigos ficam válidos para as linhas de antes). O
 *    SQLite não altera CHECK: a tabela é RECRIADA (procedimento de 12 passos da
 *    documentação do SQLite) a partir do próprio DDL gravado, só com a
 *    constraint trocada — colunas, demais CHECKs e índices iguais.
 *
 *    POR QUE `transaction = false` e `foreign_keys = OFF`: `etapa`, `evento`,
 *    `artefato`… apontam para `execucao` com `ON DELETE CASCADE`; um `DROP
 *    TABLE` com as chaves ligadas faria um `DELETE` implícito e apagaria as
 *    filhas (o `defer_foreign_keys` da 0002 só adia a CONFERÊNCIA, não a
 *    cascata). O PRAGMA não muda dentro de transação, então a migration abre a
 *    própria, confere as chaves antes do COMMIT e religa no fim.
 *
 * 2. Execuções presas em `precisa_humano` por `base_vermelha` ("o destino já
 *    falha em …", linha de base que não existe mais) voltam a andar sozinhas:
 *    `plano_pronto` se já há plano, senão `planejando` (o despachante retoma a
 *    etapa pelo estado). A nota fica no `motivo_texto` e num `evento`.
 */
export class Fj032VerificacaoPeloAgente1790000000003 implements MigrationInterface {
  name = 'Fj032VerificacaoPeloAgente1790000000003';
  transaction = false as const;

  public async up(qr: QueryRunner): Promise<void> {
    await this.emTransacaoSemChaves(qr, async () => {
      await recriarExecucaoComCheck(qr, valoresDe(NivelVerificacao));
      await destravarBaseVermelha(qr);
    });
  }

  /**
   * Volta o CHECK antigo. Linhas com os níveis novos viram `nao_verificado`
   * (o nível antigo mais conservador); as execuções destravadas não voltam a
   * travar.
   */
  public async down(qr: QueryRunner): Promise<void> {
    const antigos = ['e2e_automatizado', 'e2e_roteiro', 'verificacao_estatica', 'nao_verificado'];
    await this.emTransacaoSemChaves(qr, async () => {
      await qr.query(
        `UPDATE "execucao" SET "nivel_verificacao" = 'nao_verificado'
          WHERE "nivel_verificacao" IN ('verificado_pelo_revisor', 'declarado')`,
      );
      await recriarExecucaoComCheck(qr, antigos);
    });
  }

  /**
   * `foreign_keys = OFF` + transação própria. O `revert` do TypeORM sempre abre
   * transação antes do `down` (onde o PRAGMA não vale): ela é fechada (vazia)
   * aqui e reaberta no fim, para o TypeORM apagar o registro e commitar.
   */
  private async emTransacaoSemChaves(qr: QueryRunner, fn: () => Promise<void>): Promise<void> {
    const alheia = qr.isTransactionActive;
    if (alheia) await qr.commitTransaction();
    await qr.query('PRAGMA foreign_keys = OFF');
    try {
      await qr.startTransaction();
      await fn();
      await conferirChavesEstrangeiras(qr);
      await qr.commitTransaction();
    } catch (e) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.query('PRAGMA foreign_keys = ON');
      if (alheia) await qr.startTransaction();
    }
  }
}

const RE_CHECK_NIVEL =
  /CONSTRAINT "ck_execucao_nivel_verificacao" CHECK \("nivel_verificacao" IN \([^)]*\)\)/;

/** Recria `execucao` com o CHECK de `nivel_verificacao` = `niveis` (no-op se já for esse). */
async function recriarExecucaoComCheck(qr: QueryRunner, niveis: readonly string[]): Promise<void> {
  const [tabela] = (await qr.query(
    `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'execucao'`,
  )) as { sql: string }[];
  if (!tabela) throw new Error('tabela execucao inexistente');
  const novoCheck = checkEnum('execucao', 'nivel_verificacao', niveis);
  if (!RE_CHECK_NIVEL.test(tabela.sql)) {
    throw new Error('CHECK de execucao.nivel_verificacao não encontrado no DDL');
  }
  if (tabela.sql.includes(novoCheck)) return;
  const fkLigada = ((await qr.query('PRAGMA foreign_keys')) as { foreign_keys: number }[])[0]
    ?.foreign_keys;
  if (fkLigada) {
    // Nunca com as chaves ligadas: o DROP faria a cascata apagar as filhas.
    throw new Error('recriar execucao exige foreign_keys = OFF');
  }
  const indices = (await qr.query(
    `SELECT "sql" FROM "sqlite_master"
      WHERE "tbl_name" = 'execucao' AND "type" IN ('index', 'trigger') AND "sql" IS NOT NULL`,
  )) as { sql: string }[];
  const ddl = tabela.sql
    .replace(RE_CHECK_NIVEL, novoCheck)
    .replace(/^CREATE TABLE "execucao"/, 'CREATE TABLE "execucao_fj032"');
  if (!ddl.startsWith('CREATE TABLE "execucao_fj032"')) {
    throw new Error('DDL de execucao em formato inesperado');
  }
  await qr.query(ddl);
  await qr.query('INSERT INTO "execucao_fj032" SELECT * FROM "execucao"');
  await qr.query('DROP TABLE "execucao"');
  await qr.query('ALTER TABLE "execucao_fj032" RENAME TO "execucao"');
  for (const i of indices) await qr.query(i.sql);
}

async function destravarBaseVermelha(qr: QueryRunner): Promise<void> {
  const presas = (await qr.query(
    `SELECT e."id", e."numero", e."motivo_texto",
            EXISTS (SELECT 1 FROM "artefato" a WHERE a."execucao_id" = e."id" AND a."tipo" = 'plano') AS "tem_plano"
       FROM "execucao" e
      WHERE e."estado" = 'precisa_humano' AND e."motivo_estado" = 'base_vermelha'`,
  )) as { id: string; numero: number; motivo_texto: string | null; tem_plano: number }[];
  const agora = new Date().toISOString();
  for (const e of presas) {
    const destino = e.tem_plano ? 'plano_pronto' : 'planejando';
    const nota =
      'FJ-032: a Forja não roda mais comandos do projeto (sem linha de base); retomada automaticamente' +
      (e.motivo_texto ? ` (era: ${e.motivo_texto})` : '');
    await qr.query(
      `UPDATE "execucao"
          SET "estado" = ?, "estado_anterior" = NULL, "motivo_estado" = NULL,
              "motivo_texto" = ?, "atualizado_em" = ?
        WHERE "id" = ?`,
      [destino, nota.slice(0, 500), agora, e.id],
    );
    await qr.query(
      `INSERT INTO "evento" ("execucao_id", "etapa_id", "origem", "tipo", "nivel", "resumo", "payload", "criado_em")
       VALUES (?, NULL, 'app', 'execucao.estado', 'info', ?, ?, ?)`,
      [
        e.id,
        `#${e.numero}: precisa_humano → ${destino} (${nota})`,
        JSON.stringify({
          estado: destino,
          estado_anterior: null,
          motivo_estado: null,
          numero: e.numero,
          migracao: 'fj032',
        }),
        agora,
      ],
    );
  }
}
