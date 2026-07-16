import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration M11 (D-013 — conhecimento persistente do sistema + mapeamento):
 *
 *  1. `sistema_alvo`: mapa de conhecimento por sistema-alvo — `conhecimento_resumo`
 *     (markdown), `conhecimento_commit` (HEAD mapeado) e `conhecimento_gerado_em`.
 *     Grants/RLS da tabela já cobrem as novas colunas (não há grant por coluna).
 *
 *  2. `execucao_ia`: uma execução passa a pertencer a um CHAMADO (triagem/resolução)
 *     OU a um SISTEMA-ALVO (mapeamento), exatamente um dos dois (specs/02 §ExecucaoIA):
 *       - `chamado_id` vira NULLABLE (mantém a FK ON DELETE CASCADE já existente);
 *       - nova coluna `sistema_alvo_id` (FK NULL → `sistema_alvo`, ON DELETE CASCADE,
 *         coerente com as demais FKs de auditoria por tenant);
 *       - CHECK de exclusividade mútua: `(chamado_id IS NULL) <> (sistema_alvo_id IS NULL)`;
 *       - índice `(tenant_id, sistema_alvo_id, created_at)` para listar as execuções
 *         de mapeamento de um sistema (card "Conhecimento do sistema").
 *     As linhas existentes (todas com `chamado_id` NOT NULL, `sistema_alvo_id` NULL)
 *     já satisfazem o CHECK — sem backfill. RLS por `tenant_id` inalterada.
 */
export class M111720000008000 implements MigrationInterface {
  name = 'M111720000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 1. Mapa de conhecimento no sistema-alvo (D-013) -------------------
    await queryRunner.query(`
      ALTER TABLE "sistema_alvo"
        ADD COLUMN "conhecimento_resumo" text,
        ADD COLUMN "conhecimento_commit" text,
        ADD COLUMN "conhecimento_gerado_em" timestamptz
    `);

    // ---- 2. execucao_ia: chamado_id XOR sistema_alvo_id -------------------
    await queryRunner.query(`ALTER TABLE "execucao_ia" ALTER COLUMN "chamado_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "execucao_ia" ADD COLUMN "sistema_alvo_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "execucao_ia"
        ADD CONSTRAINT "fk_execucao_ia_sistema_alvo" FOREIGN KEY ("sistema_alvo_id")
        REFERENCES "sistema_alvo" ("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "execucao_ia"
        ADD CONSTRAINT "chk_execucao_ia_chamado_xor_sistema"
        CHECK (("chamado_id" IS NULL) <> ("sistema_alvo_id" IS NULL))
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_execucao_ia_tenant_sistema_created"
         ON "execucao_ia" ("tenant_id", "sistema_alvo_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_execucao_ia_tenant_sistema_created"`);
    await queryRunner.query(
      `ALTER TABLE "execucao_ia" DROP CONSTRAINT IF EXISTS "chk_execucao_ia_chamado_xor_sistema"`,
    );
    await queryRunner.query(
      `ALTER TABLE "execucao_ia" DROP CONSTRAINT IF EXISTS "fk_execucao_ia_sistema_alvo"`,
    );
    await queryRunner.query(`ALTER TABLE "execucao_ia" DROP COLUMN IF EXISTS "sistema_alvo_id"`);
    // Reverte chamado_id para NOT NULL. Só é seguro se não houver execução de
    // mapeamento (chamado_id NULL); o revert falharia com dados de mapeamento — o
    // operador deve expurgá-los antes (auditoria append-only; revert é de emergência).
    await queryRunner.query(`ALTER TABLE "execucao_ia" ALTER COLUMN "chamado_id" SET NOT NULL`);

    await queryRunner.query(`
      ALTER TABLE "sistema_alvo"
        DROP COLUMN IF EXISTS "conhecimento_gerado_em",
        DROP COLUMN IF EXISTS "conhecimento_commit",
        DROP COLUMN IF EXISTS "conhecimento_resumo"
    `);
  }
}
