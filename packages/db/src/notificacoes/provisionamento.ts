import type { EntityManager } from 'typeorm';
import { CanalNotificacaoTipo } from './tipos';

/**
 * Cria os canais de notificação DEFAULT do tenant no provisionamento (specs/06 §1,
 * §3.1): o canal de E-MAIL da plataforma, SEMPRE disponível (remetente/branding
 * resolvidos em runtime). O webhook é opcional e criado sob demanda quando o admin
 * o configura. Idempotente (ON CONFLICT — reexecução não duplica).
 */
export async function garantirCanaisNotificacaoDefault(
  em: EntityManager,
  tenantId: string,
): Promise<void> {
  await em.query(
    `INSERT INTO canal_notificacao (tenant_id, tipo, config, ativo)
       VALUES ($1, $2, '{}'::jsonb, true)
     ON CONFLICT (tenant_id, tipo) DO NOTHING`,
    [tenantId, CanalNotificacaoTipo.email],
  );
}
