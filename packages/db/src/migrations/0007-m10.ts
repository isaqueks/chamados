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
 * Migration M10 (busca full-text + auto-fechamento — specs/02, specs/04 §10.4/§8):
 *
 *  1. Busca full-text (E-31): coluna `busca_tsv` GERADA (`tsvector`, config
 *     `portuguese`) — título com peso `A` (mais relevante) + texto plano da
 *     descrição (derivado de `descricao_html`, tags removidas) com peso `B`.
 *     A expressão é IMMUTABLE (exigência de coluna gerada): `to_tsvector` na
 *     forma de DOIS argumentos (config constante), `setweight`, `regexp_replace`
 *     e `coalesce` são todos imutáveis. O STORED backfilla as linhas existentes.
 *     Índice GIN para o operador `@@` (o filtro por tenant continua vindo da RLS).
 *
 *  2. `chamados_tenants_ativos()` (SECURITY DEFINER): lista os `id` dos tenants
 *     `ativo` para o job de auto-fechamento iterar POR TENANT (specs/04 §8.1). É
 *     necessária porque o worker roda com o role SEM BYPASSRLS e a policy da
 *     tabela `tenant` esconderia todas as linhas antes de haver contexto de
 *     tenant (mesmo padrão de `chamados_resolver_tenant` — D-010). Retorna só o
 *     `id` (nunca dados sensíveis do tenant).
 */
export class M101720000007000 implements MigrationInterface {
  name = 'M101720000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- 1. Coluna tsvector gerada + índice GIN (E-31) ---------------------
    await queryRunner.query(`
      ALTER TABLE "chamado"
        ADD COLUMN "busca_tsv" tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('portuguese', coalesce("titulo", '')), 'A')
          ||
          setweight(
            to_tsvector(
              'portuguese',
              regexp_replace(coalesce("descricao_html", ''), '<[^>]*>', ' ', 'g')
            ),
            'B'
          )
        ) STORED
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_chamado_busca_tsv" ON "chamado" USING GIN ("busca_tsv")`,
    );

    // ---- 2. Função SECURITY DEFINER: tenants ativos (auto-fechamento) ------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "chamados_tenants_ativos"()
      RETURNS TABLE (id uuid)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT t.id
        FROM "tenant" t
        WHERE t.deleted_at IS NULL
          AND t.status = 'ativo';
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION "chamados_tenants_ativos"() FROM PUBLIC`);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION "chamados_tenants_ativos"() TO "${appRole}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS "chamados_tenants_ativos"()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_chamado_busca_tsv"`);
    await queryRunner.query(`ALTER TABLE "chamado" DROP COLUMN IF EXISTS "busca_tsv"`);
  }
}
