import type { MigrationInterface, QueryRunner } from 'typeorm';
import { StatusExecucaoIA, valoresEnum } from '@chamados/shared';
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
 * Migration M6 (infraestrutura de IA — specs/02, specs/05):
 *  - ENUM `status_execucao_ia` (5 valores canônicos de specs/05 §8:
 *    na_fila, executando, concluido, falhou, cancelado). `timeout`/`budget_excedido`
 *    NÃO são status — vão no campo `erro` (specs/05 §8; divergência de specs/02
 *    relatada na entrega do M6).
 *  - `execucao_ia`: trilha APPEND-ONLY de cada execução do pipeline do agente_ia
 *    (gatilho, provider/modelo, entrada, ações, resultado bruto, telemetria de
 *    custo/tokens/duração, erro). Grant só SELECT/INSERT/UPDATE ao role da app
 *    (sem DELETE — auditoria imutável; expurgo só por retenção).
 *  - FKs pendentes de `mensagem.execucao_ia_id` e `evento_chamado.execucao_ia_id`
 *    (colunas já criadas em M4 sem FK) → `execucao_ia(id)` ON DELETE SET NULL
 *    (a execução é auditoria; apagá-la não deve derrubar mensagem/evento).
 *  Tudo com FORCE ROW LEVEL SECURITY + policy por `app.current_tenant`.
 */
export class M61720000005000 implements MigrationInterface {
  name = 'M61720000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- ENUM status_execucao_ia (specs/05 §8) -----------------------------
    await queryRunner.query(
      `CREATE TYPE "status_execucao_ia" AS ENUM (${enumValores(valoresEnum(StatusExecucaoIA))})`,
    );

    // ---- Tabela execucao_ia (APPEND-ONLY) ----------------------------------
    await queryRunner.query(`
      CREATE TABLE "execucao_ia" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "chamado_id" uuid NOT NULL,
        "status" "status_execucao_ia" NOT NULL DEFAULT 'na_fila',
        "provider" text NOT NULL,
        "modelo" text NOT NULL,
        "gatilho" text NOT NULL,
        "entrada" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "acoes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "resultado" jsonb,
        "custo_usd" numeric(12,6),
        "tokens_entrada" integer,
        "tokens_saida" integer,
        "duracao_ms" integer,
        "erro" text,
        "iniciado_em" timestamptz,
        "finalizado_em" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_execucao_ia_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_execucao_ia_chamado" FOREIGN KEY ("chamado_id")
          REFERENCES "chamado" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_execucao_ia_tenant_chamado_created"
         ON "execucao_ia" ("tenant_id", "chamado_id", "created_at")`,
    );

    // ---- FKs pendentes (colunas criadas sem FK em M4) ----------------------
    await queryRunner.query(`
      ALTER TABLE "mensagem"
        ADD CONSTRAINT "fk_mensagem_execucao_ia" FOREIGN KEY ("execucao_ia_id")
        REFERENCES "execucao_ia" ("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "evento_chamado"
        ADD CONSTRAINT "fk_evento_execucao_ia" FOREIGN KEY ("execucao_ia_id")
        REFERENCES "execucao_ia" ("id") ON DELETE SET NULL
    `);

    // ---- RLS (FORCE + policy por tenant_id) + grant (sem DELETE) ------------
    await queryRunner.query(`ALTER TABLE "execucao_ia" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "execucao_ia" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "execucao_ia"
        USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
        WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
    `);
    // Ciclo de vida (na_fila→executando→concluido/falhou) usa UPDATE; sem DELETE.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON "execucao_ia" TO "${appRole}"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evento_chamado" DROP CONSTRAINT IF EXISTS "fk_evento_execucao_ia"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mensagem" DROP CONSTRAINT IF EXISTS "fk_mensagem_execucao_ia"`,
    );
    await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "execucao_ia"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "execucao_ia"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "status_execucao_ia"`);
  }
}
