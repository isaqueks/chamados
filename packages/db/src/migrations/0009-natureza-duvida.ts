import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0009 (D-017 — natureza "dúvida"): adiciona o valor `duvida` ao ENUM
 * `natureza` (specs/02). Dúvida = o cliente só quer entender algo; a IA responde
 * sozinha (resposta pública) e marca `resolvido`, escalando a humano apenas
 * quando não consegue. Nunca gera SPEC nem PR (specs/05 §5).
 *
 * `ALTER TYPE ... ADD VALUE` roda dentro da transação da migration (PG ≥ 12);
 * a única restrição é não USAR o valor novo na mesma transação — não usamos.
 *
 * Down: valores de ENUM não podem ser removidos diretamente — remapeia os
 * chamados `duvida` para `problema` e recria o tipo sem o valor (o padrão
 * canônico do PostgreSQL para reverter ADD VALUE).
 */
export class NaturezaDuvida1720000009000 implements MigrationInterface {
  name = 'NaturezaDuvida1720000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "natureza" ADD VALUE IF NOT EXISTS 'duvida'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "chamado" SET "natureza" = 'problema'
      WHERE "natureza" = 'duvida'`);
    await queryRunner.query(`ALTER TYPE "natureza" RENAME TO "natureza_old"`);
    await queryRunner.query(`CREATE TYPE "natureza" AS ENUM ('problema', 'alteracao')`);
    await queryRunner.query(`ALTER TABLE "chamado"
      ALTER COLUMN "natureza" TYPE "natureza" USING "natureza"::text::"natureza"`);
    await queryRunner.query(`DROP TYPE "natureza_old"`);
  }
}
