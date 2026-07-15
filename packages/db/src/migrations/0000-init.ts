import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Papel, StatusTenant, StatusUsuario, valoresEnum } from '@chamados/shared';
import { credenciaisApp } from '../config';

/** Monta a lista de valores de um ENUM para o CREATE TYPE. */
function enumValores(valores: readonly string[]): string {
  return valores.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

/** Valida um identificador SQL simples (role name). */
function identificadorSeguro(nome: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nome)) {
    throw new Error(`Identificador SQL inválido: ${nome}`);
  }
  return nome;
}

/**
 * Migration inicial (M0):
 *  - tipos ENUM canônicos usados pelas tabelas de M0;
 *  - tabelas `tenant` e `usuario` (colunas em pt-BR conforme specs/02);
 *  - role da aplicação `chamados_app` SEM BYPASSRLS;
 *  - Row-Level Security com FORCE + policies por `app.current_tenant`.
 */
export class Init1720000000000 implements MigrationInterface {
  name = 'Init1720000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);
    const appPassword = credenciaisApp.password.replace(/'/g, "''");

    // ---- ENUMs -------------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "status_tenant" AS ENUM (${enumValores(valoresEnum(StatusTenant))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "status_usuario" AS ENUM (${enumValores(valoresEnum(StatusUsuario))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "papel" AS ENUM (${enumValores(valoresEnum(Papel))})`,
    );

    // ---- Tabela tenant -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "tenant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "nome" text NOT NULL,
        "nome_exibicao" text NOT NULL,
        "status" "status_tenant" NOT NULL DEFAULT 'em_provisionamento',
        "config_branding" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "dias_fechamento_automatico" integer NOT NULL DEFAULT 3,
        "ia_resolucao_automatica_habilitada" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "uq_tenant_slug" UNIQUE ("slug")
      )
    `);

    // ---- Tabela usuario ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "usuario" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "email" text NOT NULL,
        "nome" text NOT NULL,
        "papel" "papel" NOT NULL,
        "senha_hash" text,
        "status" "status_usuario" NOT NULL DEFAULT 'ativo',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_usuario_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_usuario_tenant_email" UNIQUE ("tenant_id", "email")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_usuario_tenant" ON "usuario" ("tenant_id")`,
    );

    // ---- Role da aplicação (SEM BYPASSRLS) ---------------------------------
    // Criado de forma idempotente; a senha vem de APP_DB_PASSWORD (default dev).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
          CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}' NOBYPASSRLS;
        ELSE
          ALTER ROLE "${appRole}" LOGIN PASSWORD '${appPassword}' NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO "${appRole}"`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant", "usuario" TO "${appRole}"`,
    );

    // ---- Row-Level Security ------------------------------------------------
    // tenant: policy pela PRÓPRIA chave (id), pois é a raiz do isolamento.
    await queryRunner.query(`ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "tenant"
        USING ("id" = current_setting('app.current_tenant', true)::uuid)
        WITH CHECK ("id" = current_setting('app.current_tenant', true)::uuid)
    `);

    // usuario (e demais tabelas de negócio): policy por tenant_id.
    await queryRunner.query(`ALTER TABLE "usuario" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "usuario" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "usuario"
        USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
        WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "usuario"`);
    await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "tenant"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usuario"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "papel"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "status_usuario"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "status_tenant"`);
    // Revoga privilégios do role (não dropa o role — pode ter outros objetos).
    await queryRunner.query(`REVOKE ALL ON SCHEMA public FROM "${appRole}"`);
  }
}
