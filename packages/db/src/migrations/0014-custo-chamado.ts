import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0014 (D-043 — estimativa de custo e custo final do chamado):
 *
 *  1. ENUM novo `estimativa_custo` (`A` `B` `C` `D` `E` `I`) — faixas fixas da
 *     plataforma; rótulos/limites em `packages/shared/src/custo.ts`.
 *  2. `chamado.estimativa_custo` (NULL = sem estimativa) e `chamado.custo_final`
 *     (`numeric(12,2)`, BRL, NULL = não informado) com CHECK `>= 0`.
 *  3. ENUM `tipo_evento` ganha `estimativa_custo_alterada` e `custo_final_definido`.
 *
 * `ALTER TYPE ... ADD VALUE` roda dentro da transação da migration (PG ≥ 12); a
 * restrição é não USAR os valores novos na mesma transação — não usamos.
 * Nenhum chamado existente ganha estimativa/custo (NULL): o dado nasce agora.
 *
 * Down: remove colunas, CHECK e o enum `estimativa_custo`; o `tipo_evento` é
 * recriado sem os valores novos. Os eventos de custo são APAGADOS da trilha (não
 * há tipo anterior equivalente para remapear — diferente da 0013) — o down só
 * existe para desenvolvimento.
 */
export class CustoChamado1720000014000 implements MigrationInterface {
  name = 'CustoChamado1720000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "estimativa_custo" AS ENUM ('A', 'B', 'C', 'D', 'E', 'I')`,
    );
    await queryRunner.query(`ALTER TABLE "chamado"
      ADD COLUMN "estimativa_custo" "estimativa_custo" NULL,
      ADD COLUMN "custo_final" numeric(12,2) NULL`);
    await queryRunner.query(`ALTER TABLE "chamado"
      ADD CONSTRAINT "ck_chamado_custo_final_nao_negativo"
      CHECK ("custo_final" IS NULL OR "custo_final" >= 0)`);
    await queryRunner.query(
      `ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'estimativa_custo_alterada'`,
    );
    await queryRunner.query(
      `ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'custo_final_definido'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "evento_chamado"
      WHERE "tipo" IN ('estimativa_custo_alterada', 'custo_final_definido')`);
    await queryRunner.query(`ALTER TYPE "tipo_evento" RENAME TO "tipo_evento_old"`);
    await queryRunner.query(`CREATE TYPE "tipo_evento" AS ENUM (
      'chamado_criado', 'status_alterado', 'prioridade_alterada', 'natureza_alterada',
      'complexidade_alterada', 'operador_atribuido', 'operador_desatribuido',
      'mensagem_publicada', 'nota_interna_publicada', 'anexo_adicionado',
      'chamado_reaberto', 'chamado_resolvido', 'chamado_fechado', 'chamado_fechado_auto',
      'chamado_cancelado', 'chamado_aprovado', 'chamado_contestado', 'ia_iniciou',
      'ia_pediu_info', 'ia_diagnosticou', 'ia_abriu_pr', 'ia_gerou_spec', 'ia_falhou',
      'ia_silenciada', 'ia_reativada')`);
    await queryRunner.query(`ALTER TABLE "evento_chamado"
      ALTER COLUMN "tipo" TYPE "tipo_evento" USING "tipo"::text::"tipo_evento"`);
    await queryRunner.query(`DROP TYPE "tipo_evento_old"`);
    await queryRunner.query(
      `ALTER TABLE "chamado" DROP CONSTRAINT IF EXISTS "ck_chamado_custo_final_nao_negativo"`,
    );
    await queryRunner.query(`ALTER TABLE "chamado"
      DROP COLUMN IF EXISTS "custo_final",
      DROP COLUMN IF EXISTS "estimativa_custo"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "estimativa_custo"`);
  }
}
