import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HEADER_CAMINHO, urlLoginCom } from './caminho';
import {
  obterAppDataSource,
  carregarSessao,
  COOKIE_SESSAO,
  type TenantResolvido,
  type UsuarioAutenticado,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import { obterTenantAtual } from './tenant';

export interface ContextoRequisicao {
  tenant: TenantResolvido | null;
  usuario: UsuarioAutenticado | null;
}

/**
 * Contexto de autenticação da requisição: tenant resolvido + usuário da sessão
 * (se houver cookie válido). Memoizado por request. A validação da sessão ocorre
 * DENTRO do contexto do tenant (RLS garante que um cookie de outro tenant nunca
 * resolve aqui — specs/03 §3).
 */
export const obterContexto = cache(async (): Promise<ContextoRequisicao> => {
  const tenant = await obterTenantAtual();
  if (!tenant) return { tenant: null, usuario: null };

  const token = (await cookies()).get(COOKIE_SESSAO)?.value;
  if (!token) return { tenant, usuario: null };

  const ds = await obterAppDataSource();
  const usuario = await carregarSessao(ds, tenant.id, token);
  return { tenant, usuario };
});

/** Atalho: usuário autenticado atual (ou null). */
export async function obterUsuarioAtual(): Promise<UsuarioAutenticado | null> {
  return (await obterContexto()).usuario;
}

/**
 * Guarda de rota: exige usuário autenticado; caso contrário redireciona ao
 * /login do tenant. Retorna o contexto com `usuario` garantido não-nulo.
 */
export async function exigirUsuario(): Promise<{
  tenant: TenantResolvido;
  usuario: UsuarioAutenticado;
}> {
  const { tenant, usuario } = await obterContexto();
  // Sem tenant resolvido ou sem sessão: /login (que também trata "tenant
  // desconhecido" na própria tela, sem vazar a lista de tenants). O caminho
  // atual (header do proxy) vai em `?next=` para o deep link sobreviver ao
  // login (correção de 2026-07-22 — lib/caminho.ts).
  if (!tenant || !usuario) {
    const caminho = (await headers()).get(HEADER_CAMINHO);
    redirect(urlLoginCom(caminho));
  }
  return { tenant, usuario };
}

/** Guarda de papel: exige que o usuário tenha um dos papéis informados. */
export async function exigirPapel(...papeis: Papel[]): Promise<{
  tenant: TenantResolvido;
  usuario: UsuarioAutenticado;
}> {
  const ctx = await exigirUsuario();
  if (!papeis.includes(ctx.usuario.papel)) redirect('/app');
  return ctx;
}

export { Papel };
