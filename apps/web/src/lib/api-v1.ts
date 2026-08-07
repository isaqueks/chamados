import 'server-only';
import { In, type EntityManager } from 'typeorm';
import {
  obterAppDataSource,
  carregarSessao,
  UsuarioSchema,
  SistemaAlvoSchema,
  CategoriaSchema,
  type TenantResolvido,
  type UsuarioAutenticado,
} from '@chamados/db';
import type { Papel } from '@chamados/shared';
import { obterTenantAtual } from './tenant';
import type { Nomes } from './api-chamados';

/**
 * Núcleo da API HTTP `/api/v1` (specs/11): resolução de tenant + autenticação por
 * **Bearer**, formato de erro e utilitários de parsing/denormalização usados pelos
 * route handlers.
 *
 * Duas regras estruturais da spec vivem aqui:
 *
 *  1. **Bearer-only** (specs/11 §1.4): o cookie de sessão do navegador NÃO
 *     autentica a API. Sem isso, cada rota de escrita seria uma superfície de
 *     CSRF para quem estivesse logado no portal — o navegador anexa cookie
 *     automaticamente, mas nunca um header `Authorization`.
 *  2. **A API não é bypass** (specs/11 §1.1): estas funções só RESOLVEM quem é o
 *     ator. Toda decisão de permissão continua nos services de domínio
 *     (`autorizar()` + máquina de estados) e na RLS — nada é reimplementado aqui.
 */

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

/** Códigos de erro estáveis do contrato (specs/11 §6). */
export type CodigoErro =
  | 'corpo_invalido'
  | 'parametro_invalido'
  | 'credenciais_invalidas'
  | 'nao_autenticado'
  | 'sem_permissao'
  | 'tenant_desconhecido'
  | 'chamado_inexistente'
  | 'estado_terminal'
  | 'transicao_invalida'
  | 'conflito'
  | 'muitas_tentativas';

const SEM_CACHE = { 'cache-control': 'no-store' } as const;

export function jsonOk(dados: unknown, status = 200): Response {
  return Response.json(dados, { status, headers: SEM_CACHE });
}

/**
 * Erro no formato canônico `{ erro, codigo }` (specs/11 §6). O `codigo` é o
 * contrato estável (o cliente/MCP decide por ele); a mensagem é para humanos.
 */
export function jsonErro(status: number, codigo: CodigoErro, erro: string): Response {
  return Response.json({ erro, codigo }, { status, headers: SEM_CACHE });
}

// ---------------------------------------------------------------------------
// Contexto da requisição (tenant + usuário do Bearer)
// ---------------------------------------------------------------------------

export interface ContextoApi {
  tenant: TenantResolvido;
  usuario: UsuarioAutenticado;
  /** Token opaco apresentado (necessário para revogar no logout). */
  token: string;
}

/** Extrai o token de `Authorization: Bearer <token>` (case-insensitive). */
export function tokenDoHeader(req: Request): string | null {
  const bruto = req.headers.get('authorization');
  if (!bruto) return null;
  const m = /^Bearer\s+(.+)$/i.exec(bruto.trim());
  const token = m?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/** Só o tenant (rotas públicas da API, como o login). */
export async function exigirTenant(): Promise<TenantResolvido | Response> {
  const tenant = await obterTenantAtual();
  if (!tenant) {
    // Nunca revela a lista de tenants (specs/03 §3, specs/11 §3).
    return jsonErro(404, 'tenant_desconhecido', 'Endereço de tenant desconhecido.');
  }
  return tenant;
}

/**
 * Contexto autenticado: tenant resolvido pelo host + sessão do Bearer, validada
 * DENTRO do contexto do tenant (um token de outro tenant nunca resolve — RLS).
 * Devolve uma `Response` de erro pronta quando falha.
 */
export async function exigirContexto(req: Request): Promise<ContextoApi | Response> {
  const tenant = await exigirTenant();
  if (tenant instanceof Response) return tenant;

  const token = tokenDoHeader(req);
  if (!token) {
    return jsonErro(
      401,
      'nao_autenticado',
      'Autentique-se em POST /api/v1/sessao e envie o header Authorization: Bearer <token>.',
    );
  }

  const ds = await obterAppDataSource();
  const usuario = await carregarSessao(ds, tenant.id, token);
  if (!usuario) {
    return jsonErro(401, 'nao_autenticado', 'Sessão inválida ou expirada. Autentique-se de novo.');
  }
  return { tenant, usuario, token };
}

/** Ator no formato que os services de domínio esperam. */
export function atorDe(ctx: ContextoApi): { id: string; tenant_id: string; papel: Papel } {
  return { id: ctx.usuario.id, tenant_id: ctx.tenant.id, papel: ctx.usuario.papel };
}

// ---------------------------------------------------------------------------
// Parsing de entrada
// ---------------------------------------------------------------------------

/** Lê o corpo JSON; devolve `null` quando ausente/malformado. */
export async function lerJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const dados: unknown = await req.json();
    if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return null;
    return dados as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** String não vazia de um corpo JSON (ou `null`). */
export function textoDe(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const t = valor.trim();
  return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Denormalização de nomes (apresentação)
// ---------------------------------------------------------------------------

/**
 * Resolve nomes de usuários/sistemas/categorias em lote (um SELECT por tabela,
 * nunca N+1) para enriquecer as respostas: o consumidor da API é um assistente,
 * e "Marina" diz muito mais que um UUID.
 *
 * Roda dentro de `runInTenantContext` (RLS escopa o tenant) e só recebe ids que
 * já vieram de registros autorizados — não é caminho de leitura alternativo.
 */
export async function resolverNomes(
  em: EntityManager,
  ids: {
    usuarios?: Array<string | null | undefined>;
    sistemas?: Array<string | null | undefined>;
    categorias?: Array<string | null | undefined>;
  },
): Promise<Nomes> {
  const limpar = (v?: Array<string | null | undefined>): string[] => [
    ...new Set((v ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)),
  ];
  const usuarioIds = limpar(ids.usuarios);
  const sistemaIds = limpar(ids.sistemas);
  const categoriaIds = limpar(ids.categorias);

  const usuarios = new Map<string, { nome: string; papel: Papel }>();
  const sistemas = new Map<string, string>();
  const categorias = new Map<string, string>();

  if (usuarioIds.length > 0) {
    const linhas = await em.find(UsuarioSchema, { where: { id: In(usuarioIds) } });
    for (const u of linhas) usuarios.set(u.id, { nome: u.nome, papel: u.papel });
  }
  if (sistemaIds.length > 0) {
    const linhas = await em.find(SistemaAlvoSchema, { where: { id: In(sistemaIds) } });
    for (const s of linhas) sistemas.set(s.id, s.nome);
  }
  if (categoriaIds.length > 0) {
    const linhas = await em.find(CategoriaSchema, { where: { id: In(categoriaIds) } });
    for (const c of linhas) categorias.set(c.id, c.nome);
  }
  return { usuarios, sistemas, categorias };
}

// ---------------------------------------------------------------------------
// Tradução de motivos de domínio → HTTP
// ---------------------------------------------------------------------------

/** Motivos que os services de chamado/mensagem devolvem em `{ ok: false, motivo }`. */
type MotivoDominio = string;

/**
 * Traduz o motivo devolvido pelo domínio no par (status HTTP, código). Mantém a
 * semântica: permissão → 403, inexistente/fora do escopo → 404 (nunca vaza
 * existência), regra de negócio → 409, entrada inválida → 400.
 */
export function respostaDeMotivo(motivo: MotivoDominio): Response {
  switch (motivo) {
    case 'inexistente':
    case 'chamado_inexistente':
      return jsonErro(404, 'chamado_inexistente', 'Chamado não encontrado.');
    case 'sem_permissao':
      return jsonErro(403, 'sem_permissao', 'Seu papel não permite esta ação neste chamado.');
    case 'estado_terminal':
      return jsonErro(
        409,
        'estado_terminal',
        'Chamado encerrado (fechado/cancelado): não aceita mensagens nem transições.',
      );
    case 'mesmo_status':
      return jsonErro(409, 'transicao_invalida', 'O chamado já está nesse status.');
    case 'transicao_inexistente':
      return jsonErro(
        409,
        'transicao_invalida',
        'Transição não permitida pela máquina de estados a partir do status atual.',
      );
    case 'papel_nao_autorizado':
      return jsonErro(403, 'sem_permissao', 'Seu papel não pode fazer esta transição.');
    case 'visibilidade_invalida':
      return jsonErro(400, 'parametro_invalido', 'Visibilidade deve ser "publica" ou "interna".');
    case 'corpo_vazio':
      return jsonErro(400, 'corpo_invalido', 'O corpo da mensagem está vazio.');
    case 'corpo_muito_longo':
      return jsonErro(400, 'corpo_invalido', 'O corpo da mensagem excede o limite permitido.');
    case 'corpo_invalido':
      return jsonErro(400, 'corpo_invalido', 'O corpo da mensagem é inválido.');
    default:
      return jsonErro(409, 'conflito', `Operação recusada pelo domínio (${motivo}).`);
  }
}
