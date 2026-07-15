import { IsNull } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { StatusUsuario } from '@chamados/shared';
import { SessaoSchema, type Sessao } from '../entities/sessao';
import { UsuarioSchema, type Usuario } from '../entities/usuario';
import { runInTenantContext } from '../rls';
import { gerarTokenOpaco, hashToken } from './token';
import { SESSAO_IDLE_MS, SESSAO_ABSOLUTA_MS } from './constantes';
import type { UsuarioAutenticado } from './tipos';

/**
 * Cria uma sessão server-side no tenant corrente e devolve o TOKEN OPACO em
 * claro (vai só no cookie). O banco guarda apenas o `token_hash`.
 */
export async function criarSessao(
  em: EntityManager,
  dados: { tenant_id: string; usuario_id: string; user_agent?: string; ip?: string },
): Promise<string> {
  const token = gerarTokenOpaco();
  const agora = Date.now();
  await em.insert(SessaoSchema, {
    tenant_id: dados.tenant_id,
    usuario_id: dados.usuario_id,
    token_hash: hashToken(token),
    expira_idle_em: new Date(agora + SESSAO_IDLE_MS),
    expira_absoluta_em: new Date(agora + SESSAO_ABSOLUTA_MS),
    user_agent: dados.user_agent ?? null,
    ip: dados.ip ?? null,
  });
  return token;
}

/**
 * Valida um token de sessão no tenant corrente. Retorna o par `{ sessao, usuario }`
 * se a sessão estiver ativa (não revogada, dentro dos dois prazos) e o usuário
 * ainda ativo. Desliza a expiração por inatividade a cada uso. `null` caso
 * contrário. A RLS garante que uma sessão de OUTRO tenant nunca é encontrada aqui.
 */
export async function validarSessao(
  em: EntityManager,
  token: string,
): Promise<{ sessao: Sessao; usuario: Usuario } | null> {
  const sessao = await em.findOne(SessaoSchema, {
    where: { token_hash: hashToken(token) },
  });
  if (!sessao) return null;

  const agora = new Date();
  if (sessao.revogada_em) return null;
  if (sessao.expira_absoluta_em <= agora) return null;
  if (sessao.expira_idle_em <= agora) return null;

  const usuario = await em.findOne(UsuarioSchema, {
    where: { id: sessao.usuario_id, status: StatusUsuario.ativo, deleted_at: IsNull() },
  });
  if (!usuario) return null;

  // Expiração deslizante por inatividade.
  const novoIdle = new Date(agora.getTime() + SESSAO_IDLE_MS);
  await em.update(SessaoSchema, { id: sessao.id }, { expira_idle_em: novoIdle });

  return { sessao, usuario };
}

/** Revoga uma sessão pelo token (logout). Idempotente. */
export async function revogarSessaoPorToken(
  em: EntityManager,
  token: string,
): Promise<void> {
  await em.update(
    SessaoSchema,
    { token_hash: hashToken(token), revogada_em: IsNull() },
    { revogada_em: new Date() },
  );
}

/**
 * Revoga TODAS as sessões ativas de um usuário (troca/reset de senha, expulsão
 * do tenant — specs/03 §4.3/§4.4). Retorna quantas foram revogadas.
 */
export async function revogarSessoesDoUsuario(
  em: EntityManager,
  usuario_id: string,
): Promise<number> {
  const res = await em.update(
    SessaoSchema,
    { usuario_id, revogada_em: IsNull() },
    { revogada_em: new Date() },
  );
  return res.affected ?? 0;
}

/**
 * Orquestração para a camada web: valida o cookie de sessão dentro do contexto
 * do tenant resolvido e devolve o usuário autenticado (ou `null`). A RLS garante
 * que um cookie de outro tenant nunca resolve aqui (specs/03 §3).
 */
export async function carregarSessao(
  ds: DataSource,
  tenantId: string,
  token: string,
): Promise<UsuarioAutenticado | null> {
  return runInTenantContext(ds, tenantId, async (em) => {
    const r = await validarSessao(em, token);
    if (!r) return null;
    const { usuario } = r;
    return {
      id: usuario.id,
      tenant_id: usuario.tenant_id,
      email: usuario.email,
      nome: usuario.nome,
      papel: usuario.papel,
      avatar_url: usuario.avatar_url,
    };
  });
}

/** Logout: revoga a sessão do cookie no tenant corrente. */
export async function encerrarSessao(
  ds: DataSource,
  tenantId: string,
  token: string,
): Promise<void> {
  await runInTenantContext(ds, tenantId, (em) => revogarSessaoPorToken(em, token));
}

/**
 * Abre uma sessão para um usuário já conhecido (ex.: logo após aceitar convite),
 * sem reverificar senha. Retorna o token opaco do cookie.
 */
export async function abrirSessao(
  ds: DataSource,
  tenantId: string,
  usuarioId: string,
  dados: { user_agent?: string; ip?: string } = {},
): Promise<string> {
  return runInTenantContext(ds, tenantId, (em) =>
    criarSessao(em, {
      tenant_id: tenantId,
      usuario_id: usuarioId,
      user_agent: dados.user_agent,
      ip: dados.ip,
    }),
  );
}
