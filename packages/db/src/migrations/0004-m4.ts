import type { MigrationInterface, QueryRunner } from 'typeorm';
import { VisibilidadeMensagem, TipoEvento, valoresEnum } from '@chamados/shared';
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
 * Migration M4 (Mensagens, anexos, eventos — specs/02, specs/04, specs/09):
 *  - ENUMs `visibilidade_mensagem` e `tipo_evento` (taxonomia canônica de specs/02).
 *  - `mensagem`: timeline (pública/interna), corpo em dupla representação
 *    (json fonte + html sanitizado), imutável no MVP; soft delete p/ retenção.
 *  - `anexo`: metadados + `storage_key` (objeto no bucket com prefixo por tenant),
 *    tipo real validado no upload, flag `inline`; CHECK (chamado_id OU mensagem_id).
 *  - `evento_chamado`: trilha APPEND-ONLY (sem updated_at/deleted_at); grant só
 *    SELECT/INSERT ao role da aplicação (imutável na prática).
 *  Todas com FORCE ROW LEVEL SECURITY + policy por `app.current_tenant`. FKs para
 *  `chamado`/`mensagem`/`tenant` com ON DELETE CASCADE (retenção/expurgo).
 */
export class M41720000004000 implements MigrationInterface {
  name = 'M41720000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- ENUMs (specs/02) --------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "visibilidade_mensagem" AS ENUM (${enumValores(valoresEnum(VisibilidadeMensagem))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "tipo_evento" AS ENUM (${enumValores(valoresEnum(TipoEvento))})`,
    );

    // ---- Tabela mensagem ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "mensagem" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "chamado_id" uuid NOT NULL,
        "autor_id" uuid NOT NULL,
        "visibilidade" "visibilidade_mensagem" NOT NULL DEFAULT 'publica',
        "corpo_json" jsonb NOT NULL,
        "corpo_html" text NOT NULL,
        "execucao_ia_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_mensagem_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_mensagem_chamado" FOREIGN KEY ("chamado_id")
          REFERENCES "chamado" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_mensagem_autor" FOREIGN KEY ("autor_id")
          REFERENCES "usuario" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_mensagem_tenant_chamado_created"
         ON "mensagem" ("tenant_id", "chamado_id", "created_at")`,
    );

    // ---- Tabela anexo ------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "anexo" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "chamado_id" uuid,
        "mensagem_id" uuid,
        "nome_arquivo" text NOT NULL,
        "content_type" text NOT NULL,
        "tamanho_bytes" bigint NOT NULL,
        "storage_key" text NOT NULL,
        "checksum_sha256" text,
        "inline" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_anexo_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_anexo_chamado" FOREIGN KEY ("chamado_id")
          REFERENCES "chamado" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_anexo_mensagem" FOREIGN KEY ("mensagem_id")
          REFERENCES "mensagem" ("id") ON DELETE CASCADE,
        CONSTRAINT "ck_anexo_dono"
          CHECK ("chamado_id" IS NOT NULL OR "mensagem_id" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_anexo_tenant_chamado" ON "anexo" ("tenant_id", "chamado_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_anexo_tenant_mensagem" ON "anexo" ("tenant_id", "mensagem_id")`,
    );

    // ---- Tabela evento_chamado (APPEND-ONLY) -------------------------------
    await queryRunner.query(`
      CREATE TABLE "evento_chamado" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "chamado_id" uuid NOT NULL,
        "tipo" "tipo_evento" NOT NULL,
        "ator_id" uuid,
        "execucao_ia_id" uuid,
        "dados" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_evento_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_evento_chamado" FOREIGN KEY ("chamado_id")
          REFERENCES "chamado" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_evento_ator" FOREIGN KEY ("ator_id")
          REFERENCES "usuario" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_evento_tenant_chamado_created"
         ON "evento_chamado" ("tenant_id", "chamado_id", "created_at")`,
    );

    // ---- RLS (FORCE + policy por tenant_id) + grants -----------------------
    for (const tabela of ['mensagem', 'anexo', 'evento_chamado']) {
      await queryRunner.query(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${tabela}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON "${tabela}"
          USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
          WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
      `);
    }
    // mensagem/anexo: CRUD (soft delete usa UPDATE). evento_chamado: só append.
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "mensagem", "anexo" TO "${appRole}"`,
    );
    await queryRunner.query(`GRANT SELECT, INSERT ON "evento_chamado" TO "${appRole}"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabela of ['evento_chamado', 'anexo', 'mensagem']) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${tabela}"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }
    await queryRunner.query(`DROP TYPE IF EXISTS "tipo_evento"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "visibilidade_mensagem"`);
  }
}
