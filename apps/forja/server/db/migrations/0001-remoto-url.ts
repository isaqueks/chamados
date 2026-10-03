import type { MigrationInterface, QueryRunner } from 'typeorm';
import { conferirChavesEstrangeiras } from './util';

/**
 * `projeto.remoto_url` (specs/forja/05 §9): a URL do remoto capturada no
 * cadastro do projeto (e, na falta, no primeiro preparo, antes de qualquer
 * agente rodar). Antes de cada fetch/push o app confere `git remote get-url`
 * (e `--push`) contra ela: um `remote set-url`/`pushurl`/`insteadOf` plantado
 * por script bloqueia o item em vez de buscar T0 de um destino forjado ou
 * empurrar para outro lugar. Coluna simples, sem CHECK: `ADD COLUMN` basta.
 */
export class RemotoUrl1790000000001 implements MigrationInterface {
  name = 'RemotoUrl1790000000001';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "projeto" ADD COLUMN "remoto_url" TEXT`);
    await conferirChavesEstrangeiras(qr);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "projeto" DROP COLUMN "remoto_url"`);
  }
}
