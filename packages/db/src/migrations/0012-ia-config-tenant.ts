import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0012 (D-044 — modelo, esforço e timeout da IA por tenant): colunas
 * NULLABLE em `tenant`:
 *  - `ia_modelo` (text): ID do modelo (charset `[a-z0-9.-]`, ≤ 64 — validado no
 *    config-service);
 *  - `ia_esforco` (text): `low|medium|high|xhigh|max`;
 *  - `ia_timeout_ms` (integer): timeout da TRIAGEM (1 min ≤ t ≤ teto derivado do
 *    limiar de execução órfã).
 * `NULL` = "Padrão da instalação" (`IA_MODELO`/`IA_ESFORCO`/`IA_TIMEOUT_MS`).
 *
 * Sem CHECK no banco de propósito: a lista de esforços e o teto do timeout
 * dependem do SDK e da config da instalação; o worker trata valor inválido
 * como ausente (cai no default — mesma filosofia de D-031) e a gravação valida.
 * A policy RLS de `tenant` (por `id`) já cobre as colunas novas.
 */
export class IaConfigTenant1720000012000 implements MigrationInterface {
  name = 'IaConfigTenant1720000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant"
      ADD COLUMN "ia_modelo" text NULL,
      ADD COLUMN "ia_esforco" text NULL,
      ADD COLUMN "ia_timeout_ms" integer NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant"
      DROP COLUMN "ia_timeout_ms",
      DROP COLUMN "ia_esforco",
      DROP COLUMN "ia_modelo"`);
  }
}
