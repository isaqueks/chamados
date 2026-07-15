'use server';

import { revalidatePath } from 'next/cache';
import { obterAppDataSource, runInTenantContext, criarConvite, revogarConvite } from '@chamados/db';
import { autorizar, Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { urlAbsoluta } from '@/lib/url';
import { enviarEmailTransacional } from '@/lib/email';

export interface EstadoConvite {
  erro?: string;
  sucesso?: string;
}

const PAPEIS_CONVIDAVEIS: Papel[] = [Papel.admin, Papel.operador, Papel.cliente];

/** Admin cria convite por e-mail + papel (specs/03 §4.2). authorize é a fronteira. */
export async function acaoCriarConvite(
  _prev: EstadoConvite,
  formData: FormData,
): Promise<EstadoConvite> {
  const { tenant, usuario } = await exigirUsuario();

  const email = String(formData.get('email') ?? '').trim();
  const papel = String(formData.get('papel') ?? '') as Papel;
  if (!email) return { erro: 'Informe o e-mail do convidado.' };
  if (!PAPEIS_CONVIDAVEIS.includes(papel)) return { erro: 'Papel inválido.' };

  const permitido = autorizar(usuario, 'usuario', 'convidar', {
    papel_convidado: papel,
    operador_pode_convidar_cliente: true,
  });
  if (!permitido) {
    return { erro: 'Você não tem permissão para convidar com este papel.' };
  }

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    criarConvite(em, {
      tenant_id: tenant.id,
      email,
      papel,
      criado_por: usuario.id,
    }),
  );
  if (!r.ok) {
    return { erro: 'Já existe uma conta para este e-mail neste tenant.' };
  }

  const url = await urlAbsoluta(`/aceitar-convite?token=${encodeURIComponent(r.token)}`);
  await enviarEmailTransacional({ tipo: 'convite', tenantId: tenant.id, destinatario: email, url });

  revalidatePath('/app/usuarios');
  return {
    sucesso: `Convite enviado para ${email}. O link de acesso também fica no log do servidor (dev).`,
  };
}

/** Revoga um convite pendente (admin). */
export async function acaoRevogarConvite(formData: FormData): Promise<void> {
  const { tenant, usuario } = await exigirUsuario();
  if (!autorizar(usuario, 'usuario', 'listar')) return;

  const conviteId = String(formData.get('conviteId') ?? '');
  if (!conviteId) return;

  const ds = await obterAppDataSource();
  await runInTenantContext(ds, tenant.id, (em) => revogarConvite(em, conviteId));
  revalidatePath('/app/usuarios');
}
