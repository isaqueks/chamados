'use server';

import { revalidatePath } from 'next/cache';
import {
  obterAppDataSource,
  runInTenantContext,
  criarConvite,
  revogarConvite,
  atualizarPerfilUsuario,
  LIMITE_NOME_MIN,
  LIMITE_NOME_MAX,
  type MotivoAtualizarPerfil,
} from '@chamados/db';
import { autorizar, Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { urlAbsoluta } from '@/lib/url';
import { enviarEmailTransacional } from '@/lib/email';

export interface EstadoConvite {
  erro?: string;
  sucesso?: string;
}

export interface EstadoUsuario {
  erro?: string;
  sucesso?: string;
  /** Id do usuário editado — a linha usa para exibir o retorno no lugar certo. */
  usuarioId?: string;
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

const MOTIVOS_PERFIL: Record<MotivoAtualizarPerfil, string> = {
  sem_permissao: 'Apenas administradores podem editar contas.',
  proprio_usuario: 'Você não pode editar a própria conta por aqui.',
  conta_de_servico: 'O assistente de IA é uma conta de serviço e não é editável.',
  inexistente: 'Conta não encontrada.',
  nome_invalido: `O nome deve ter entre ${LIMITE_NOME_MIN} e ${LIMITE_NOME_MAX} caracteres.`,
  email_invalido: 'E-mail inválido.',
  email_em_uso: 'Já existe uma conta ou convite pendente com este e-mail.',
};

/**
 * Admin edita nome e e-mail de OUTRA conta do tenant (specs/03 §5.1, D-029).
 * A decisão de permissão é do service (`autorizar()` + regras de domínio); aqui
 * só traduzimos o formulário e o motivo de falha para linguagem de gente.
 */
export async function acaoEditarUsuario(
  _prev: EstadoUsuario,
  formData: FormData,
): Promise<EstadoUsuario> {
  const { tenant, usuario } = await exigirUsuario();

  const usuarioId = String(formData.get('usuarioId') ?? '');
  const nome = String(formData.get('nome') ?? '');
  const email = String(formData.get('email') ?? '');
  if (!usuarioId) return { erro: 'Conta não informada.' };

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    atualizarPerfilUsuario(em, usuario, usuarioId, { nome, email }),
  );
  if (!r.ok) return { erro: MOTIVOS_PERFIL[r.motivo], usuarioId };

  // Auditoria em log estruturado (specs/03 §5.1): não há tabela de auditoria de
  // configuração — a lacuna está registrada como decisão pendente na spec.
  console.info(
    JSON.stringify({
      evt: 'usuario_editado',
      tenant_id: tenant.id,
      ator_id: usuario.id,
      alvo_id: usuarioId,
      email_alterado: r.emailAlterado,
      sessoes_revogadas: r.sessoesRevogadas,
      ts: new Date().toISOString(),
    }),
  );

  revalidatePath('/app/usuarios');
  return {
    sucesso: r.emailAlterado
      ? `Conta atualizada. Como o e-mail mudou, as sessões de ${r.nome} foram encerradas — o acesso volta com o novo endereço.`
      : 'Conta atualizada.',
    usuarioId,
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
