import type { MigrationInterface, QueryRunner } from 'typeorm';
import { StatusConvite, valoresEnum } from '@chamados/shared';
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
 * Migration M1 (autenticação, perfis e permissões — specs/03):
 *  - completa a tabela `usuario` com colunas canônicas de auth (specs/02):
 *    `credencial_servico_ref`, `avatar_url`, `ultimo_acesso_em`; CHECK do
 *    agente_ia (sem senha) e unicidade de um agente_ia por tenant;
 *  - adiciona `tenant.dominio_proprio` (coluna canônica de specs/02; resolução
 *    por domínio próprio só é usada a partir do M2);
 *  - cria as tabelas `sessao`, `convite` e `redefinicao_senha` (cookie opaco
 *    server-side, convites e reset de senha), todas com RLS FORCE + policies por
 *    `app.current_tenant`, índices da spec e grants ao role da aplicação;
 *  - cria a função `chamados_resolver_tenant` (SECURITY DEFINER) para resolver o
 *    tenant por slug/domínio ANTES de haver contexto de tenant (a app roda com
 *    role SEM BYPASSRLS e a policy da tabela `tenant` esconderia todas as linhas).
 */
export class Auth1720000001000 implements MigrationInterface {
  name = 'Auth1720000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = identificadorSeguro(credenciaisApp.username);

    // ---- tenant: domínio próprio (canônico specs/02; uso pleno no M2) --------
    await queryRunner.query(`ALTER TABLE "tenant" ADD COLUMN "dominio_proprio" text`);
    await queryRunner.query(
      `ALTER TABLE "tenant" ADD CONSTRAINT "uq_tenant_dominio_proprio" UNIQUE ("dominio_proprio")`,
    );

    // ---- usuario: colunas de auth que faltavam (specs/02) --------------------
    await queryRunner.query(`ALTER TABLE "usuario" ADD COLUMN "credencial_servico_ref" text`);
    await queryRunner.query(`ALTER TABLE "usuario" ADD COLUMN "avatar_url" text`);
    await queryRunner.query(`ALTER TABLE "usuario" ADD COLUMN "ultimo_acesso_em" timestamptz`);
    // agente_ia autentica só por credencial de serviço: nunca tem senha_hash.
    await queryRunner.query(`
      ALTER TABLE "usuario" ADD CONSTRAINT "ck_usuario_agente_ia_sem_senha"
        CHECK ("papel" <> 'agente_ia' OR "senha_hash" IS NULL)
    `);
    // No máximo um agente_ia por tenant (ativo).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_usuario_agente_ia_por_tenant"
        ON "usuario" ("tenant_id")
        WHERE "papel" = 'agente_ia' AND "deleted_at" IS NULL
    `);

    // ---- ENUM status_convite -------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "status_convite" AS ENUM (${enumValores(valoresEnum(StatusConvite))})`,
    );

    // ---- Tabela sessao -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "sessao" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "usuario_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "expira_idle_em" timestamptz NOT NULL,
        "expira_absoluta_em" timestamptz NOT NULL,
        "revogada_em" timestamptz,
        "user_agent" text,
        "ip" inet,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sessao_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sessao_usuario" FOREIGN KEY ("usuario_id")
          REFERENCES "usuario" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_sessao_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_sessao_tenant_usuario" ON "sessao" ("tenant_id", "usuario_id")`,
    );

    // ---- Tabela convite ------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "convite" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "email" text NOT NULL,
        "papel" "papel" NOT NULL,
        "token_hash" text NOT NULL,
        "expira_em" timestamptz NOT NULL,
        "status" "status_convite" NOT NULL DEFAULT 'pendente',
        "criado_por" uuid,
        "aceito_em" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_convite_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_convite_criado_por" FOREIGN KEY ("criado_por")
          REFERENCES "usuario" ("id") ON DELETE SET NULL,
        CONSTRAINT "uq_convite_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_convite_tenant_email" ON "convite" ("tenant_id", "email")`,
    );
    // Um convite PENDENTE por e-mail por tenant.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_convite_pendente_email"
        ON "convite" ("tenant_id", "email")
        WHERE "status" = 'pendente'
    `);

    // ---- Tabela redefinicao_senha (token de uso único de reset) --------------
    await queryRunner.query(`
      CREATE TABLE "redefinicao_senha" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "usuario_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "expira_em" timestamptz NOT NULL,
        "usado_em" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_redefinicao_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_redefinicao_usuario" FOREIGN KEY ("usuario_id")
          REFERENCES "usuario" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_redefinicao_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_redefinicao_tenant_usuario"
        ON "redefinicao_senha" ("tenant_id", "usuario_id")
    `);

    // ---- RLS (FORCE + policy por tenant_id) nas 3 tabelas novas --------------
    for (const tabela of ['sessao', 'convite', 'redefinicao_senha']) {
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

    // ---- Função de resolução de tenant (pré-contexto) ------------------------
    // SECURITY DEFINER: roda com privilégios do owner (superuser das migrations,
    // BYPASSRLS), permitindo resolver o tenant por slug/domínio ANTES de haver
    // `app.current_tenant`. Retorna só o mínimo necessário (nunca lista tenants).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "chamados_resolver_tenant"(p_slug text, p_dominio text)
      RETURNS TABLE (
        id uuid,
        slug text,
        dominio_proprio text,
        nome_exibicao text,
        status "status_tenant",
        config_branding jsonb
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT t.id, t.slug, t.dominio_proprio, t.nome_exibicao, t.status, t.config_branding
        FROM "tenant" t
        WHERE t.deleted_at IS NULL
          AND (
            (p_slug IS NOT NULL AND t.slug = p_slug)
            OR (p_dominio IS NOT NULL AND t.dominio_proprio = p_dominio)
          )
        LIMIT 1;
      $$;
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION "chamados_resolver_tenant"(text, text) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION "chamados_resolver_tenant"(text, text) TO "${appRole}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS "chamados_resolver_tenant"(text, text)`);

    for (const tabela of ['redefinicao_senha', 'convite', 'sessao']) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${tabela}"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }

    await queryRunner.query(`DROP TYPE IF EXISTS "status_convite"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_usuario_agente_ia_por_tenant"`);
    await queryRunner.query(
      `ALTER TABLE "usuario" DROP CONSTRAINT IF EXISTS "ck_usuario_agente_ia_sem_senha"`,
    );
    await queryRunner.query(`ALTER TABLE "usuario" DROP COLUMN IF EXISTS "ultimo_acesso_em"`);
    await queryRunner.query(`ALTER TABLE "usuario" DROP COLUMN IF EXISTS "avatar_url"`);
    await queryRunner.query(`ALTER TABLE "usuario" DROP COLUMN IF EXISTS "credencial_servico_ref"`);

    await queryRunner.query(
      `ALTER TABLE "tenant" DROP CONSTRAINT IF EXISTS "uq_tenant_dominio_proprio"`,
    );
    await queryRunner.query(`ALTER TABLE "tenant" DROP COLUMN IF EXISTS "dominio_proprio"`);
  }
}
