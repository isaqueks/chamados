import { IsNull } from 'typeorm';
import type { DataSource } from 'typeorm';
import { RedefinicaoSenhaSchema } from '../entities/redefinicao-senha';
import { runInTenantContext } from '../rls';
import { gerarTokenOpaco, hashToken } from './token';
import { REDEFINICAO_TTL_MS } from './constantes';
import { verificarSenha } from './senha';
import {
  buscarUsuarioAtivoPorEmail,
  buscarUsuarioPorId,
  definirSenha,
} from './usuario-service';
import { revogarSessoesDoUsuario } from './sessao-service';

/**
 * "Esqueci a senha" (specs/03 §4.3). Se houver conta ativa no tenant, gera um
 * token de uso único (TTL curto) e devolve o token em claro para o e-mail stub.
 * Retorna `null` quando não há conta — o CHAMADOR deve exibir SEMPRE a mesma
 * mensagem genérica (anti-enumeração), logando a URL só quando houver token.
 */
export async function solicitarRedefinicao(
  ds: DataSource,
  tenantId: string,
  email: string,
): Promise<{ token: string; email: string } | null> {
  return runInTenantContext(ds, tenantId, async (em) => {
    const usuario = await buscarUsuarioAtivoPorEmail(em, email);
    if (!usuario || !usuario.senha_hash) return null; // agente_ia (sem senha) não reseta

    const token = gerarTokenOpaco();
    await em.insert(RedefinicaoSenhaSchema, {
      tenant_id: tenantId,
      usuario_id: usuario.id,
      token_hash: hashToken(token),
      expira_em: new Date(Date.now() + REDEFINICAO_TTL_MS),
    });
    return { token, email: usuario.email };
  });
}

export type ResultadoRedefinir =
  | { ok: true }
  | { ok: false; motivo: 'invalido' | 'expirado' | 'usado' };

/**
 * Redefine a senha a partir do token de uso único. Marca o token como usado e
 * REVOGA todas as sessões da conta (specs/03 §4.3). Idempotência: um token já
 * usado é recusado.
 */
export async function redefinirComToken(
  ds: DataSource,
  tenantId: string,
  token: string,
  novaSenha: string,
): Promise<ResultadoRedefinir> {
  return runInTenantContext(ds, tenantId, async (em) => {
    const registro = await em.findOne(RedefinicaoSenhaSchema, {
      where: { token_hash: hashToken(token) },
    });
    if (!registro) return { ok: false, motivo: 'invalido' };
    if (registro.usado_em) return { ok: false, motivo: 'usado' };
    if (registro.expira_em <= new Date()) return { ok: false, motivo: 'expirado' };

    await definirSenha(em, registro.usuario_id, novaSenha);
    await em.update(
      RedefinicaoSenhaSchema,
      { id: registro.id },
      { usado_em: new Date() },
    );
    // Invalida também outros tokens de reset pendentes da mesma conta.
    await em.update(
      RedefinicaoSenhaSchema,
      { usuario_id: registro.usuario_id, usado_em: IsNull() },
      { usado_em: new Date() },
    );
    await revogarSessoesDoUsuario(em, registro.usuario_id);
    return { ok: true };
  });
}

export type ResultadoTrocarSenha = { ok: true } | { ok: false; motivo: 'senha_atual_invalida' };

/**
 * Troca de senha por usuário logado (specs/03 §4.3): exige a senha atual e
 * revoga todas as sessões da conta ao concluir.
 */
export async function trocarSenha(
  ds: DataSource,
  tenantId: string,
  usuarioId: string,
  senhaAtual: string,
  novaSenha: string,
): Promise<ResultadoTrocarSenha> {
  return runInTenantContext(ds, tenantId, async (em) => {
    const usuario = await buscarUsuarioPorId(em, usuarioId);
    if (!usuario || !(await verificarSenha(usuario.senha_hash, senhaAtual))) {
      return { ok: false, motivo: 'senha_atual_invalida' };
    }
    await definirSenha(em, usuarioId, novaSenha);
    await revogarSessoesDoUsuario(em, usuarioId);
    return { ok: true };
  });
}
