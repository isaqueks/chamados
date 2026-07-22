import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0011 (D-024 — silenciar a IA por chamado): coluna
 * `chamado.ia_silenciada` (boolean NOT NULL default false) + os eventos de
 * auditoria `ia_silenciada`/`ia_reativada` no ENUM `tipo_evento` (specs/02).
 * Com a flag ligada, NENHUMA triagem roda no chamado (automática ou manual) —
 * o worker descarta o job; a reativação é manual (operador/admin).
 *
 * `ALTER TYPE ... ADD VALUE` roda na transação da migration (PG ≥ 12); a única
 * restrição é não USAR os valores novos na mesma transação — não usamos.
 *
 * Down: remove a coluna e recria o `tipo_evento` sem os valores novos (padrão
 * canônico do PostgreSQL para reverter ADD VALUE), apagando antes os eventos
 * que os usam (são só trilha de auditoria da flag removida).
 */
export class IaSilenciada1720000011000 implements MigrationInterface {
  name = 'IaSilenciada1720000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chamado" ADD COLUMN "ia_silenciada" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'ia_silenciada'`);
    await queryRunner.query(`ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'ia_reativada'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chamado" DROP COLUMN "ia_silenciada"`);
    await queryRunner.query(`DELETE FROM "evento_chamado"
      WHERE "tipo" IN ('ia_silenciada', 'ia_reativada')`);
    await queryRunner.query(`ALTER TYPE "tipo_evento" RENAME TO "tipo_evento_old"`);
    await queryRunner.query(`CREATE TYPE "tipo_evento" AS ENUM (
      'chamado_criado', 'status_alterado', 'prioridade_alterada', 'natureza_alterada',
      'complexidade_alterada', 'operador_atribuido', 'operador_desatribuido',
      'mensagem_publicada', 'nota_interna_publicada', 'anexo_adicionado',
      'chamado_reaberto', 'chamado_resolvido', 'chamado_fechado', 'chamado_fechado_auto',
      'chamado_cancelado', 'ia_iniciou', 'ia_pediu_info', 'ia_diagnosticou',
      'ia_abriu_pr', 'ia_gerou_spec', 'ia_falhou')`);
    await queryRunner.query(`ALTER TABLE "evento_chamado"
      ALTER COLUMN "tipo" TYPE "tipo_evento" USING "tipo"::text::"tipo_evento"`);
    await queryRunner.query(`DROP TYPE "tipo_evento_old"`);
  }
}
