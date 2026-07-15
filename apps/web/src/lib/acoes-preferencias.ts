'use server';

import { revalidatePath } from 'next/cache';
import {
  obterAppDataSource,
  runInTenantContext,
  idCanalEmail,
  definirPreferencia,
  papelDestinatario,
  type EventoNotificavel,
} from '@chamados/db';
import { exigirUsuario } from '@/lib/sessao';

export type ResultadoPreferenciaUi = { ok: true } | { ok: false; msg: string };

/**
 * Define uma preferência de notificação (por e-mail) do usuário logado (specs/06
 * §7). Recusa desabilitar eventos OBRIGATÓRIOS. Serve às DUAS áreas (/app e
 * /portal); o papel é derivado do usuário da sessão.
 */
export async function acaoDefinirPreferencia(
  evento: string,
  habilitado: boolean,
): Promise<ResultadoPreferenciaUi> {
  const { tenant, usuario } = await exigirUsuario();
  const papel = papelDestinatario(usuario.papel);
  if (!papel) return { ok: false, msg: 'Seu perfil não gerencia preferências de notificação.' };

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, async (em) => {
    const canalId = await idCanalEmail(em);
    if (!canalId) return { tipo: 'sem_canal' as const };
    const res = await definirPreferencia(
      em,
      tenant.id,
      usuario.id,
      evento as EventoNotificavel,
      canalId,
      habilitado,
      papel,
    );
    return { tipo: 'ok' as const, res };
  });

  if (r.tipo === 'sem_canal') return { ok: false, msg: 'Canal de e-mail indisponível.' };
  if (!r.res.ok) {
    return {
      ok: false,
      msg:
        r.res.motivo === 'obrigatorio'
          ? 'Este evento é obrigatório e não pode ser desativado.'
          : 'Evento inválido.',
    };
  }
  revalidatePath('/app/preferencias');
  revalidatePath('/portal/preferencias');
  return { ok: true };
}
