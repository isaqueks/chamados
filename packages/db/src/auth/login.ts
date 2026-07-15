import type { DataSource } from 'typeorm';
import { Papel, StatusTenant } from '@chamados/shared';
import { runInTenantContext } from '../rls';
import { gerarHashSenha, verificarSenha } from './senha';
import { buscarUsuarioAtivoPorEmail, registrarUltimoAcesso } from './usuario-service';
import { criarSessao } from './sessao-service';
import type { ResultadoLogin, TenantResolvido } from './tipos';

/**
 * Hash "isca" para equalizar o tempo de resposta quando não há conta (evita
 * enumeração de contas por timing). Calculado sob demanda, uma vez.
 */
let hashIscaPromise: Promise<string> | null = null;
function hashIsca(): Promise<string> {
  if (!hashIscaPromise) hashIscaPromise = gerarHashSenha('senha-isca-inexistente');
  return hashIscaPromise;
}

/** Um usuário humano pode logar no tenant, dado o status do tenant? */
function tenantPermiteLogin(tenant: TenantResolvido, papel: Papel): boolean {
  switch (tenant.status) {
    case StatusTenant.ativo:
      return true;
    case StatusTenant.em_provisionamento:
      // Libera apenas o admin inicial até concluir o setup (specs/07 §1.1).
      return papel === Papel.admin;
    case StatusTenant.suspenso:
    case StatusTenant.cancelado:
      return false;
    default:
      return false;
  }
}

/**
 * Autentica por e-mail + senha no tenant resolvido (specs/03 §4.1). Resposta
 * sempre genérica em caso de falha (`{ ok: false }`) — nunca revela se a conta
 * existe. `agente_ia` nunca loga por este fluxo (senha_hash NULL ⇒ falha).
 * Em sucesso, cria a sessão server-side e devolve o token opaco do cookie.
 */
export async function autenticarComSenha(
  ds: DataSource,
  tenant: TenantResolvido,
  entrada: { email: string; senha: string; userAgent?: string; ip?: string },
): Promise<ResultadoLogin> {
  const usuario = await runInTenantContext(ds, tenant.id, (em) =>
    buscarUsuarioAtivoPorEmail(em, entrada.email),
  );

  // Verificação de senha SEMPRE ocorre (mesmo sem conta / sem hash), para
  // equalizar o tempo de resposta.
  const podeAutenticar =
    !!usuario && usuario.papel !== Papel.agente_ia && tenantPermiteLogin(tenant, usuario.papel);

  const hashParaVerificar = usuario?.senha_hash ?? (await hashIsca());
  const senhaOk = await verificarSenha(hashParaVerificar, entrada.senha);

  if (!podeAutenticar || !senhaOk || !usuario) {
    return { ok: false };
  }

  const token = await runInTenantContext(ds, tenant.id, async (em) => {
    const t = await criarSessao(em, {
      tenant_id: tenant.id,
      usuario_id: usuario.id,
      user_agent: entrada.userAgent,
      ip: entrada.ip,
    });
    await registrarUltimoAcesso(em, usuario.id);
    return t;
  });

  return {
    ok: true,
    token,
    usuario: {
      id: usuario.id,
      tenant_id: usuario.tenant_id,
      email: usuario.email,
      nome: usuario.nome,
      papel: usuario.papel,
      avatar_url: usuario.avatar_url,
    },
  };
}
