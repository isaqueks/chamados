import type { MigrationInterface, QueryRunner } from 'typeorm';
import { credenciaisApp } from '../config';

/** Valida um identificador SQL simples (role name). */
function identificadorSeguro(nome: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nome)) {
    throw new Error(`Identificador SQL inválido: ${nome}`);
  }
  return nome;
}

/**
 * Migration M2 (SistemaAlvo + Categoria + cofre de segredos — specs/02, 07, 09):
 *  - `segredo`: cofre local de segredos cifrados (envelope encryption). O `id`
 *    é a referência de segredo (`*_ref`). RLS por tenant_id.
 *  - `sistema_alvo`: repositório git, logs e conexão BD read-only; credenciais
 *    apenas por referência ao cofre (specs/07 §5.1). RLS por tenant_id.
 *  - `categoria`: classificação do tenant; a "Geral" é criada no provisionamento.
 *    RLS por tenant_id.
 *  Todas com FORCE ROW LEVEL SECURITY, policy por `app.current_tenant` e grants
 *  ao role da aplicação (SEM BYPASSRLS).
 */
export class M21720000002000 implements MigrationInterface {
  name = 'M21720000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- Tabela segredo (cofre) --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "segredo" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "dek_cifrada" text NOT NULL,
        "valor_cifrado" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_segredo_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_segredo_tenant" ON "segredo" ("tenant_id")`,
    );

    // ---- Tabela sistema_alvo -----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "sistema_alvo" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "nome" text NOT NULL,
        "descricao" text,
        "git_repo_url" text NOT NULL,
        "git_credencial_ref" text,
        "git_branch_padrao" text NOT NULL DEFAULT 'main',
        "logs_tipo" text,
        "logs_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "logs_credencial_ref" text,
        "bd_tipo" text,
        "bd_host" text,
        "bd_porta" integer,
        "bd_nome" text,
        "bd_credencial_ref" text,
        "ativo" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_sistema_alvo_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_sistema_alvo_tenant_nome" UNIQUE ("tenant_id", "nome")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_sistema_alvo_tenant" ON "sistema_alvo" ("tenant_id")`,
    );

    // ---- Tabela categoria ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "categoria" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "nome" text NOT NULL,
        "descricao" text,
        "ativo" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_categoria_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_categoria_tenant_nome" UNIQUE ("tenant_id", "nome")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_categoria_tenant" ON "categoria" ("tenant_id")`,
    );

    // ---- RLS (FORCE + policy por tenant_id) + grants ------------------------
    for (const tabela of ['segredo', 'sistema_alvo', 'categoria']) {
      await queryRunner.query(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${tabela}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON "${tabela}"
          USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
          WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
      `);
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${tabela}" TO "${appRole}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabela of ['categoria', 'sistema_alvo', 'segredo']) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${tabela}"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }
  }
}
