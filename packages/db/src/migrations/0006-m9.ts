import type { MigrationInterface, QueryRunner } from 'typeorm';
import { valoresEnum } from '@chamados/shared';
import { CanalNotificacaoTipo, StatusNotificacao } from '../notificacoes/tipos';
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
 * Migration M9 (notificações — specs/02, specs/06):
 *  - ENUMs `canal_notificacao_tipo` (email/whatsapp/sms/push/webhook) e
 *    `status_notificacao` (pendente/entregue/aceito/falha_temporaria/
 *    falha_permanente). O tipo de canal NÃO se chama `canal_notificacao` para
 *    não colidir com a TABELA homônima (tabela e tipo dividem namespace no PG).
 *  - `canal_notificacao`: config de gateway plugável por tenant (email da
 *    plataforma + webhook com url/segredo-ref, contador de falhas, auto-desativação).
 *  - `preferencia_notificacao`: (usuário × evento × canal) → habilitado.
 *  - `notificacao_log`: idempotência (unique em idempotency_key) + status/tentativas.
 *  Tudo com FORCE ROW LEVEL SECURITY + policy por `app.current_tenant`.
 */
export class M91720000006000 implements MigrationInterface {
  name = 'M91720000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- ENUMs -------------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "canal_notificacao_tipo" AS ENUM (${enumValores(valoresEnum(CanalNotificacaoTipo))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "status_notificacao" AS ENUM (${enumValores(valoresEnum(StatusNotificacao))})`,
    );

    // ---- Tabela canal_notificacao ------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "canal_notificacao" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "tipo" "canal_notificacao_tipo" NOT NULL,
        "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "ativo" boolean NOT NULL DEFAULT true,
        "falhas_consecutivas" integer NOT NULL DEFAULT 0,
        "desativado_em" timestamptz,
        "ultimo_erro" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_canal_notificacao_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_canal_notificacao_tenant_tipo"
         ON "canal_notificacao" ("tenant_id", "tipo")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_canal_notificacao_tenant" ON "canal_notificacao" ("tenant_id")`,
    );

    // ---- Tabela preferencia_notificacao ------------------------------------
    await queryRunner.query(`
      CREATE TABLE "preferencia_notificacao" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "usuario_id" uuid NOT NULL,
        "evento" text NOT NULL,
        "canal_id" uuid NOT NULL,
        "habilitado" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_preferencia_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_preferencia_usuario" FOREIGN KEY ("usuario_id")
          REFERENCES "usuario" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_preferencia_canal" FOREIGN KEY ("canal_id")
          REFERENCES "canal_notificacao" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_preferencia_usuario_evento_canal"
         ON "preferencia_notificacao" ("tenant_id", "usuario_id", "evento", "canal_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_preferencia_tenant_usuario"
         ON "preferencia_notificacao" ("tenant_id", "usuario_id")`,
    );

    // ---- Tabela notificacao_log --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "notificacao_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "idempotency_key" text NOT NULL,
        "chamado_id" uuid,
        "evento" text NOT NULL,
        "canal" "canal_notificacao_tipo" NOT NULL,
        "destinatario_id" uuid,
        "destino" text NOT NULL,
        "status" "status_notificacao" NOT NULL DEFAULT 'pendente',
        "tentativas" integer NOT NULL DEFAULT 0,
        "ultimo_erro" text,
        "id_externo" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_notificacao_log_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_notificacao_log_chamado" FOREIGN KEY ("chamado_id")
          REFERENCES "chamado" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_notificacao_log_destinatario" FOREIGN KEY ("destinatario_id")
          REFERENCES "usuario" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_notificacao_log_idempotency"
         ON "notificacao_log" ("idempotency_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_notificacao_log_tenant_chamado"
         ON "notificacao_log" ("tenant_id", "chamado_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_notificacao_log_tenant_created"
         ON "notificacao_log" ("tenant_id", "created_at")`,
    );

    // ---- RLS (FORCE + policy por tenant_id) + grants -----------------------
    for (const tabela of ['canal_notificacao', 'preferencia_notificacao', 'notificacao_log']) {
      await queryRunner.query(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${tabela}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON "${tabela}"
          USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
          WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
      `);
    }

    // canal/preferência mudam de estado (config, toggles, contador de falhas,
    // soft delete) → UPDATE/DELETE; log reaproveita a linha por idempotência → UPDATE.
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "canal_notificacao" TO "${appRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "preferencia_notificacao" TO "${appRole}"`,
    );
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON "notificacao_log" TO "${appRole}"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabela of ['notificacao_log', 'preferencia_notificacao', 'canal_notificacao']) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${tabela}"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }
    await queryRunner.query(`DROP TYPE IF EXISTS "status_notificacao"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "canal_notificacao_tipo"`);
  }
}
