import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  valoresEnum,
} from '@chamados/shared';
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
 * Migration M3 (Chamado — specs/02, specs/04):
 *  - ENUMs canônicos do chamado: `status_chamado`, `natureza`, `prioridade`,
 *    `complexidade` (E-14). `visibilidade_mensagem` fica para M4, junto da
 *    entidade `Mensagem` que a consome.
 *  - `tenant_contador`: numeração sequencial por tenant, transacional e sem
 *    buracos (specs/02 "Numeração de chamados por tenant"). RLS por tenant_id.
 *  - `chamado`: entidade central com todos os campos canônicos, CHECKs
 *    (título 3..160; sistema_alvo XOR categoria) e índices (inclui o parcial de
 *    auto-fechamento). RLS FORCE + policy por `app.current_tenant` + grants ao
 *    role da aplicação (SEM BYPASSRLS).
 *
 * O índice GIN de busca full-text (`tsvector`) é escopo de M10 (E-31) e não é
 * criado aqui.
 */
export class M31720000003000 implements MigrationInterface {
  name = 'M31720000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- ENUMs do chamado (E-14) -------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "status_chamado" AS ENUM (${enumValores(valoresEnum(StatusChamado))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "natureza" AS ENUM (${enumValores(valoresEnum(Natureza))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "prioridade" AS ENUM (${enumValores(valoresEnum(Prioridade))})`,
    );
    await queryRunner.query(
      `CREATE TYPE "complexidade" AS ENUM (${enumValores(valoresEnum(Complexidade))})`,
    );

    // ---- Contador por tenant (numeração sem buracos) -----------------------
    await queryRunner.query(`
      CREATE TABLE "tenant_contador" (
        "tenant_id" uuid PRIMARY KEY,
        "proximo_numero" bigint NOT NULL DEFAULT 1,
        CONSTRAINT "fk_tenant_contador_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE
      )
    `);

    // ---- Tabela chamado -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "chamado" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "numero" bigint NOT NULL,
        "sistema_alvo_id" uuid,
        "categoria_id" uuid,
        "cliente_id" uuid NOT NULL,
        "operador_id" uuid,
        "titulo" text NOT NULL,
        "descricao_json" jsonb NOT NULL,
        "descricao_html" text NOT NULL,
        "status" "status_chamado" NOT NULL DEFAULT 'novo',
        "natureza" "natureza" NOT NULL,
        "prioridade" "prioridade" NOT NULL DEFAULT 'media',
        "complexidade" "complexidade",
        "resolvido_em" timestamptz,
        "fechar_automaticamente_em" timestamptz,
        "fechado_em" timestamptz,
        "reaberto_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "fk_chamado_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chamado_sistema_alvo" FOREIGN KEY ("sistema_alvo_id")
          REFERENCES "sistema_alvo" ("id"),
        CONSTRAINT "fk_chamado_categoria" FOREIGN KEY ("categoria_id")
          REFERENCES "categoria" ("id"),
        CONSTRAINT "fk_chamado_cliente" FOREIGN KEY ("cliente_id")
          REFERENCES "usuario" ("id"),
        CONSTRAINT "fk_chamado_operador" FOREIGN KEY ("operador_id")
          REFERENCES "usuario" ("id"),
        CONSTRAINT "uq_chamado_tenant_numero" UNIQUE ("tenant_id", "numero"),
        CONSTRAINT "ck_chamado_titulo_len"
          CHECK (char_length("titulo") BETWEEN 3 AND 160),
        CONSTRAINT "ck_chamado_alvo"
          CHECK ("sistema_alvo_id" IS NOT NULL OR "categoria_id" IS NOT NULL)
      )
    `);

    // ---- Índices (specs/02 "Índices principais") ---------------------------
    await queryRunner.query(
      `CREATE INDEX "ix_chamado_tenant_status_updated"
         ON "chamado" ("tenant_id", "status", "updated_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chamado_tenant_cliente_created"
         ON "chamado" ("tenant_id", "cliente_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chamado_tenant_operador_status"
         ON "chamado" ("tenant_id", "operador_id", "status")`,
    );
    // Índice PARCIAL do job de auto-fechamento (specs/02, specs/04 §8.1).
    await queryRunner.query(
      `CREATE INDEX "ix_chamado_autofechamento"
         ON "chamado" ("tenant_id", "fechar_automaticamente_em")
         WHERE "status" = 'resolvido'`,
    );

    // ---- RLS (FORCE + policy por tenant_id) + grants -----------------------
    for (const tabela of ['tenant_contador', 'chamado']) {
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
    for (const tabela of ['chamado', 'tenant_contador']) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${tabela}"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }
    await queryRunner.query(`DROP TYPE IF EXISTS "complexidade"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "prioridade"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "natureza"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "status_chamado"`);
  }
}
