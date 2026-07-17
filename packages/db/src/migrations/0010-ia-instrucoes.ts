import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0010 (D-020 — instruções do tenant para a IA): coluna
 * `tenant.ia_instrucoes` (text NULL). Texto livre do ADMIN com orientações
 * adicionais para a IA (tom, contexto do negócio, prioridades), injetado no
 * system prompt da triagem numa seção demarcada e SUBORDINADA às regras da
 * plataforma (specs/05 §4.1, specs/07 §4.1). Cap de 4.000 chars imposto na
 * camada de serviço (config-service), não no banco.
 */
export class IaInstrucoes1720000010000 implements MigrationInterface {
  name = 'IaInstrucoes1720000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant" ADD COLUMN "ia_instrucoes" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant" DROP COLUMN "ia_instrucoes"`);
  }
}
