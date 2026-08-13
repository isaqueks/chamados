import { IsNull, Not, type EntityManager } from 'typeorm';
import { autorizar, Papel, StatusConvite, StatusUsuario, type Ator } from '@chamados/shared';
import { UsuarioSchema, type Usuario } from '../entities/usuario';
import { ConviteSchema } from '../entities/convite';
import { gerarHashSenha } from './senha';
import { revogarSessoesDoUsuario } from './sessao-service';

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
export async function buscarUsuarioPorId(em: EntityManager, id: string): Promise<Usuario | null> {
  return em.findOne(UsuarioSchema, { where: { id } });
}

/** Verifica se já existe conta (qualquer status não-removido) para o e-mail. */
export async function existeContaPorEmail(em: EntityManager, email: string): Promise<boolean> {
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
  credencialServicoRef: string | null,
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
  await em.update(UsuarioSchema, { id: usuario_id }, { senha_hash, status: StatusUsuario.ativo });
}

/** Marca o último acesso do usuário (login bem-sucedido). */
export async function registrarUltimoAcesso(em: EntityManager, usuario_id: string): Promise<void> {
  await em.update(UsuarioSchema, { id: usuario_id }, { ultimo_acesso_em: new Date() });
}

// ---------------------------------------------------------------------------
// Edição de identidade pelo admin (specs/03 §5.1, D-029)
// ---------------------------------------------------------------------------

/** Limites do nome de exibição (não há CHECK no banco; a regra é da aplicação). */
export const LIMITE_NOME_MIN = 2;
export const LIMITE_NOME_MAX = 120;

/**
 * Validação de e-mail deliberadamente FROUXA: um endereço só é provado válido
 * entregando mensagem nele. Barramos o que é inequivocamente quebrado (sem `@`,
 * sem domínio, com espaço/vírgula, dois `@`) e deixamos o resto passar — regex
 * "RFC completa" rejeita endereços legítimos e não impede os inválidos de verdade.
 */
export function emailValido(email: string): boolean {
  const e = normalizarEmail(email);
  if (e.length < 6 || e.length > 254) return false;
  // Barrados: quebra de linha (injeção de cabeçalho no envio) e os separadores
  // estruturais de uma lista de endereços. O apóstrofo NÃO entra aqui — é legítimo
  // em local-part (`o'brien@…`) e inofensivo num header.
  if (/[\s,;<>"\\]/.test(e)) return false;
  const partes = e.split('@');
  if (partes.length !== 2) return false;
  const [local, dominio] = partes as [string, string];
  if (local.length === 0 || dominio.length < 3) return false;
  if (!dominio.includes('.') || dominio.startsWith('.') || dominio.endsWith('.')) return false;
  if (dominio.includes('..')) return false;
  return true;
}

export type MotivoAtualizarPerfil =
  | 'inexistente'
  | 'sem_permissao'
  | 'proprio_usuario'
  | 'conta_de_servico'
  | 'nome_invalido'
  | 'email_invalido'
  | 'email_em_uso';

export type ResultadoAtualizarPerfil =
  | { ok: true; nome: string; email: string; emailAlterado: boolean; sessoesRevogadas: number }
  | { ok: false; motivo: MotivoAtualizarPerfil };

/**
 * Atualiza NOME e E-MAIL de outra conta do tenant (specs/03 §5.1, D-029).
 *
 * Só `admin` (a decisão é do `autorizar()`, ponto único de specs/03 §9). RLS
 * escopa o tenant; o `usuarioId` de outro tenant simplesmente não é encontrado.
 *
 * Regras que existem por um motivo, não por gosto:
 *  - **própria conta recusada**: perfil próprio é outro fluxo, e a revogação de
 *    sessões abaixo deslogaria o admin no meio da edição;
 *  - **`agente_ia` recusado**: service account sem login (specs/03 §6);
 *  - **e-mail é credencial** (specs/03 §4.1): ao trocá-lo, TODAS as sessões da
 *    conta alterada são revogadas — sessão viva autenticada por uma identidade
 *    que não existe mais é exatamente o que não queremos;
 *  - **unicidade** cobre conta existente E convite pendente: deixar passar um
 *    e-mail com convite pendente empurra a colisão para o aceite, que falharia
 *    na ativação de alguém — o pior momento possível.
 */
export async function atualizarPerfilUsuario(
  em: EntityManager,
  ator: Ator,
  usuarioId: string,
  dados: { nome: string; email: string },
): Promise<ResultadoAtualizarPerfil> {
  if (!autorizar(ator, 'usuario', 'editar')) return { ok: false, motivo: 'sem_permissao' };
  if (usuarioId === ator.id) return { ok: false, motivo: 'proprio_usuario' };

  const alvo = await em.findOne(UsuarioSchema, {
    where: { id: usuarioId, deleted_at: IsNull() },
  });
  if (!alvo) return { ok: false, motivo: 'inexistente' };
  if (alvo.papel === Papel.agente_ia) return { ok: false, motivo: 'conta_de_servico' };

  const nome = dados.nome.trim();
  if (nome.length < LIMITE_NOME_MIN || nome.length > LIMITE_NOME_MAX) {
    return { ok: false, motivo: 'nome_invalido' };
  }

  const email = normalizarEmail(dados.email);
  if (!emailValido(email)) return { ok: false, motivo: 'email_invalido' };

  const emailAlterado = email !== alvo.email;
  if (emailAlterado) {
    const jaUsado = await em.count(UsuarioSchema, {
      where: { email, id: Not(usuarioId) },
    });
    if (jaUsado > 0) return { ok: false, motivo: 'email_em_uso' };

    const convitePendente = await em.count(ConviteSchema, {
      where: { email, status: StatusConvite.pendente },
    });
    if (convitePendente > 0) return { ok: false, motivo: 'email_em_uso' };
  }

  await em.update(UsuarioSchema, { id: usuarioId }, { nome, email });

  // Troca de credencial de login → sessões da conta ALTERADA caem (specs/03 §4.3).
  const sessoesRevogadas = emailAlterado ? await revogarSessoesDoUsuario(em, usuarioId) : 0;

  return { ok: true, nome, email, emailAlterado, sessoesRevogadas };
}
