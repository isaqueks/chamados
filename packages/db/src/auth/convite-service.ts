import { IsNull } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { Papel, StatusConvite, StatusUsuario } from '@chamados/shared';
import { ConviteSchema, type Convite } from '../entities/convite';
import { UsuarioSchema, type Usuario } from '../entities/usuario';
import { runInTenantContext } from '../rls';
import { gerarTokenOpaco, hashToken } from './token';
import { CONVITE_TTL_MS } from './constantes';
import { criarUsuarioAtivoComSenha, existeContaPorEmail, normalizarEmail } from './usuario-service';

export type ResultadoCriarConvite =
  { ok: true; token: string; convite_id: string } | { ok: false; motivo: 'conta_existente' };

/**
 * Cria um convite pendente no tenant corrente (specs/03 §4.2). Se já houver
 * conta para o e-mail, recusa (ajusta-se a conta existente, não se convida de
 * novo). Se houver convite pendente para o e-mail, ele é revogado e um novo é
 * emitido (reenvio). Devolve o TOKEN em claro (vai no link do e-mail; e-mail é
 * stub até o M9 — quem chama loga a URL).
 */
export async function criarConvite(
  em: EntityManager,
  dados: { tenant_id: string; email: string; papel: Papel; criado_por: string },
): Promise<ResultadoCriarConvite> {
  const email = normalizarEmail(dados.email);

  if (await existeContaPorEmail(em, email)) {
    return { ok: false, motivo: 'conta_existente' };
  }

  // Reenvio: revoga qualquer convite pendente para o mesmo e-mail.
  await em.update(
    ConviteSchema,
    { email, status: StatusConvite.pendente },
    { status: StatusConvite.revogado },
  );

  const token = gerarTokenOpaco();
  const res = await em.insert(ConviteSchema, {
    tenant_id: dados.tenant_id,
    email,
    papel: dados.papel,
    token_hash: hashToken(token),
    expira_em: new Date(Date.now() + CONVITE_TTL_MS),
    status: StatusConvite.pendente,
    criado_por: dados.criado_por,
  });
  return { ok: true, token, convite_id: res.identifiers[0]!.id as string };
}

/** Busca um convite pelo token (no tenant corrente). `null` se não existir. */
export async function buscarConvitePorToken(
  em: EntityManager,
  token: string,
): Promise<Convite | null> {
  return em.findOne(ConviteSchema, { where: { token_hash: hashToken(token) } });
}

/** Um convite está aceitável agora? (pendente e dentro do TTL) */
export function conviteAceitavel(convite: Convite): boolean {
  return convite.status === StatusConvite.pendente && convite.expira_em > new Date();
}

export type ResultadoAceite =
  | { ok: true; usuario_id: string; papel: Papel }
  | { ok: false; motivo: 'invalido' | 'expirado' | 'conta_existente' };

/**
 * Aceita um convite: define a senha e materializa uma conta ATIVA com o papel
 * convidado (specs/03 §4.2). Consome o convite (status → aceito).
 */
export async function aceitarConvite(
  em: EntityManager,
  token: string,
  dados: { nome: string; senha: string },
): Promise<ResultadoAceite> {
  const convite = await buscarConvitePorToken(em, token);
  if (!convite || convite.status !== StatusConvite.pendente) {
    return { ok: false, motivo: 'invalido' };
  }
  if (convite.expira_em <= new Date()) {
    // Marca como expirado (higiene); segue negando.
    await em.update(ConviteSchema, { id: convite.id }, { status: StatusConvite.expirado });
    return { ok: false, motivo: 'expirado' };
  }
  if (await existeContaPorEmail(em, convite.email)) {
    return { ok: false, motivo: 'conta_existente' };
  }

  const usuario_id = await criarUsuarioAtivoComSenha(em, {
    tenant_id: convite.tenant_id,
    email: convite.email,
    nome: dados.nome,
    papel: convite.papel,
    senha: dados.senha,
  });

  await em.update(
    ConviteSchema,
    { id: convite.id },
    { status: StatusConvite.aceito, aceito_em: new Date() },
  );

  return { ok: true, usuario_id, papel: convite.papel };
}

/** Revoga um convite pendente (admin). */
export async function revogarConvite(em: EntityManager, convite_id: string): Promise<void> {
  await em.update(
    ConviteSchema,
    { id: convite_id, status: StatusConvite.pendente },
    { status: StatusConvite.revogado },
  );
}

/** Lista convites pendentes do tenant (admin). */
export async function listarConvitesPendentes(em: EntityManager): Promise<Convite[]> {
  return em.find(ConviteSchema, {
    where: { status: StatusConvite.pendente },
    order: { created_at: 'DESC' },
  });
}

/** Lista usuários ativos/pendentes do tenant (admin). */
export async function listarUsuarios(em: EntityManager): Promise<Usuario[]> {
  return em.find(UsuarioSchema, {
    where: { deleted_at: IsNull() },
    order: { created_at: 'ASC' },
  });
}

/** Informação pública mínima de um convite (para a tela de aceite). */
export interface InfoConvite {
  email: string;
  papel: Papel;
  aceitavel: boolean;
}

/** Consulta um convite pelo token (orquestração com contexto de tenant). */
export async function consultarConvite(
  ds: DataSource,
  tenantId: string,
  token: string,
): Promise<InfoConvite | null> {
  return runInTenantContext(ds, tenantId, async (em) => {
    const c = await buscarConvitePorToken(em, token);
    if (!c) return null;
    return { email: c.email, papel: c.papel, aceitavel: conviteAceitavel(c) };
  });
}

/** Aceite de convite (orquestração com contexto de tenant). */
export async function aceitarConviteFluxo(
  ds: DataSource,
  tenantId: string,
  token: string,
  dados: { nome: string; senha: string },
): Promise<ResultadoAceite> {
  return runInTenantContext(ds, tenantId, (em) => aceitarConvite(em, token, dados));
}

/** Reexporta para conveniência do papel na UI. */
export { Papel, StatusConvite, StatusUsuario };
