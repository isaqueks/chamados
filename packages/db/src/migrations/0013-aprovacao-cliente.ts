import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 0013 (D-042 — janela de aprovação do cliente):
 *
 *  1. ENUM `tipo_evento` ganha `chamado_aprovado` (o cliente aprovou a resolução,
 *     `resolvido → fechado`) e `chamado_contestado` (o cliente contestou com
 *     mensagem, `resolvido → em_atendimento`). A aprovação TÁCITA reutiliza
 *     `chamado_fechado_auto` (specs/02).
 *  2. `tenant.dias_fechamento_automatico` — agora o PRAZO PARA O CLIENTE APROVAR
 *     OU CONTESTAR — passa a ter DEFAULT 7 (antes 3).
 *  3. Tenants que ainda estão no padrão antigo (valor 3) passam a 7. SUPOSIÇÃO
 *     registrada no ADR D-042: não há como distinguir "3 escolhido pelo admin"
 *     de "3 herdado do default" (a coluna nunca guardou essa diferença); como o
 *     pedido do usuário define 7 como o novo padrão e 3 era o default de todos
 *     os tenants provisionados, tratamos 3 como default. Quem configurou
 *     QUALQUER outro valor não muda. Chamados já `resolvido` mantêm o prazo já
 *     gravado em `fechar_automaticamente_em` (a janela é materializada na
 *     resolução); o novo prazo vale a partir da próxima resolução.
 *
 * `ALTER TYPE ... ADD VALUE` roda dentro da transação da migration (PG ≥ 12);
 * a única restrição é não USAR os valores novos na mesma transação — não usamos
 * (o UPDATE do passo 3 só toca `tenant`).
 *
 * Down: DEFAULT volta a 3 (os dados de `dias_fechamento_automatico` ficam — 7 é
 * um valor válido e não dá para saber quem era 3); o `tipo_evento` é recriado
 * sem os valores novos, REMAPEANDO a trilha em vez de apagá-la:
 * `chamado_aprovado → chamado_fechado`, `chamado_contestado → chamado_reaberto`
 * (era o que o sistema gravava antes da D-042).
 */
export class AprovacaoCliente1720000013000 implements MigrationInterface {
  name = 'AprovacaoCliente1720000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'chamado_aprovado'`);
    await queryRunner.query(
      `ALTER TYPE "tipo_evento" ADD VALUE IF NOT EXISTS 'chamado_contestado'`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant" ALTER COLUMN "dias_fechamento_automatico" SET DEFAULT 7`,
    );
    await queryRunner.query(
      `UPDATE "tenant" SET "dias_fechamento_automatico" = 7 WHERE "dias_fechamento_automatico" = 3`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant" ALTER COLUMN "dias_fechamento_automatico" SET DEFAULT 3`,
    );
    await queryRunner.query(`UPDATE "evento_chamado" SET "tipo" = 'chamado_fechado'
      WHERE "tipo" = 'chamado_aprovado'`);
    await queryRunner.query(`UPDATE "evento_chamado" SET "tipo" = 'chamado_reaberto'
      WHERE "tipo" = 'chamado_contestado'`);
    await queryRunner.query(`ALTER TYPE "tipo_evento" RENAME TO "tipo_evento_old"`);
    await queryRunner.query(`CREATE TYPE "tipo_evento" AS ENUM (
      'chamado_criado', 'status_alterado', 'prioridade_alterada', 'natureza_alterada',
      'complexidade_alterada', 'operador_atribuido', 'operador_desatribuido',
      'mensagem_publicada', 'nota_interna_publicada', 'anexo_adicionado',
      'chamado_reaberto', 'chamado_resolvido', 'chamado_fechado', 'chamado_fechado_auto',
      'chamado_cancelado', 'ia_iniciou', 'ia_pediu_info', 'ia_diagnosticou',
      'ia_abriu_pr', 'ia_gerou_spec', 'ia_falhou', 'ia_silenciada', 'ia_reativada')`);
    await queryRunner.query(`ALTER TABLE "evento_chamado"
      ALTER COLUMN "tipo" TYPE "tipo_evento" USING "tipo"::text::"tipo_evento"`);
    await queryRunner.query(`DROP TYPE "tipo_evento_old"`);
  }
}
