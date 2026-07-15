import type { EntityManager } from 'typeorm';
import { Papel, StatusUsuario } from '@chamados/shared';
import { UsuarioSchema, type Usuario } from '../entities/usuario';
import { gerarHashSenha } from './senha';

/** Normaliza e-mail para comparação/armazenamento (case-insensitive, sem espaços). */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Busca um usuário ativo por e-mail no tenant corrente (RLS já escopa por
 * tenant). Ignora removidos/soft-deletados. `null` se não houver.
 */
export async function buscarUsuarioAtivoPorEmail(
  em: EntityManager,
  email: string,
): Promise<Usuario | null> {
  return em.findOne(UsuarioSchema, {
    where: {
      email: normalizarEmail(email),
      status: StatusUsuario.ativo,
      deleted_at: undefined,
    },
  });
}

/** Busca um usuário por id no tenant corrente. */
export async function buscarUsuarioPorId(
  em: EntityManager,
  id: string,
): Promise<Usuario | null> {
  return em.findOne(UsuarioSchema, { where: { id } });
}

/** Verifica se já existe conta (qualquer status não-removido) para o e-mail. */
export async function existeContaPorEmail(
  em: EntityManager,
  email: string,
): Promise<boolean> {
  const n = await em.count(UsuarioSchema, {
    where: { email: normalizarEmail(email) },
  });
  return n > 0;
}

/**
 * Cria um usuário humano ATIVO com senha (uso: seed de dev e aceite de convite
 * quando a conta ainda não existe). Retorna o id.
 */
export async function criarUsuarioAtivoComSenha(
  em: EntityManager,
  dados: { tenant_id: string; email: string; nome: string; papel: Papel; senha: string },
): Promise<string> {
  const senha_hash = await gerarHashSenha(dados.senha);
  const res = await em.insert(UsuarioSchema, {
    tenant_id: dados.tenant_id,
    email: normalizarEmail(dados.email),
    nome: dados.nome,
    papel: dados.papel,
    senha_hash,
    status: StatusUsuario.ativo,
  });
  return res.identifiers[0]!.id as string;
}

/**
 * Garante o service account `agente_ia` do tenant (um por tenant). Sem senha
 * (senha_hash NULL); autentica por credencial de serviço (specs/03 §6).
 * Idempotente. Retorna o id do agente_ia.
 */
export async function garantirAgenteIA(
  em: EntityManager,
  tenant_id: string,
  credencialServicoRef: string,
): Promise<string> {
  const existente = await em.findOne(UsuarioSchema, {
    where: { papel: Papel.agente_ia },
  });
  if (existente) return existente.id;

  const res = await em.insert(UsuarioSchema, {
    tenant_id,
    email: normalizarEmail(`agente-ia@${tenant_id}.servico.local`),
    nome: 'Assistente',
    papel: Papel.agente_ia,
    senha_hash: null,
    credencial_servico_ref: credencialServicoRef,
    status: StatusUsuario.ativo,
  });
  return res.identifiers[0]!.id as string;
}

/**
 * Define/troca a senha de um usuário e o marca como ativo. Não revoga sessões
 * aqui — quem chama decide (o fluxo de reset/troca revoga todas as sessões).
 */
export async function definirSenha(
  em: EntityManager,
  usuario_id: string,
  senha: string,
): Promise<void> {
  const senha_hash = await gerarHashSenha(senha);
  await em.update(
    UsuarioSchema,
    { id: usuario_id },
    { senha_hash, status: StatusUsuario.ativo },
  );
}

/** Marca o último acesso do usuário (login bem-sucedido). */
export async function registrarUltimoAcesso(
  em: EntityManager,
  usuario_id: string,
): Promise<void> {
  await em.update(UsuarioSchema, { id: usuario_id }, { ultimo_acesso_em: new Date() });
}
