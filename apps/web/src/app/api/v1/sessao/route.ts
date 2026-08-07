import { headers } from 'next/headers';
import {
  obterAppDataSource,
  autenticarComSenha,
  encerrarSessao,
  consumirRateLimit,
  mensagemRateLimit,
  SESSAO_IDLE_MS,
} from '@chamados/db';
import { exigirTenant, jsonErro, jsonOk, lerJson, textoDe, tokenDoHeader } from '@/lib/api-v1';

// Node runtime (pg/argon2) e nunca pré-renderizado.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sessão da API (specs/11 §2). Autentica por **e-mail + senha** — nenhuma
 * credencial nova — e devolve o MESMO token opaco de `Sessao` usado pelo cookie:
 * server-side, revogável, com os TTLs de specs/03 §4.4.
 *
 * Reusa `autenticarComSenha`: Argon2id, verificação em tempo constante (anti
 * timing), `agente_ia` recusado (senha nula) e tenant suspenso/cancelado
 * bloqueado. Falha SEMPRE genérica (anti-enumeração — specs/03 §4.1): o cliente
 * não distingue "conta não existe" de "senha errada".
 */
export async function POST(req: Request): Promise<Response> {
  const tenant = await exigirTenant();
  if (tenant instanceof Response) return tenant;

  const corpo = await lerJson(req);
  if (!corpo) return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "email" e "senha".');

  const email = textoDe(corpo.email);
  const senha = typeof corpo.senha === 'string' ? corpo.senha : null;
  if (!email || !senha) {
    return jsonErro(400, 'corpo_invalido', 'Informe "email" e "senha".');
  }

  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;

  // Mesmo rate limit do login da UI (specs/03 §4.1): tenant+IP e tenant+e-mail,
  // fail-open se o Redis estiver fora. A API não pode ser a porta de brute-force
  // que a tela fechou.
  const rl = await consumirRateLimit('login', { tenantId: tenant.id, ip, email });
  if (!rl.ok) return jsonErro(429, 'muitas_tentativas', mensagemRateLimit(rl.retryAposS));

  const ds = await obterAppDataSource();
  const r = await autenticarComSenha(ds, tenant, {
    email,
    senha,
    userAgent: h.get('user-agent') ?? undefined,
    ip,
  });
  if (!r.ok) return jsonErro(401, 'credenciais_invalidas', 'E-mail ou senha inválidos.');

  return jsonOk({
    token: r.token,
    // Expiração por INATIVIDADE (a sessão desliza a cada uso); o teto absoluto
    // vive no banco. É o prazo que interessa ao cliente para saber quando
    // reautenticar (specs/03 §4.4).
    expira_em: new Date(Date.now() + SESSAO_IDLE_MS).toISOString(),
    usuario: {
      id: r.usuario.id,
      nome: r.usuario.nome,
      email: r.usuario.email,
      papel: r.usuario.papel,
    },
    tenant: { slug: tenant.slug, nome_exibicao: tenant.nome_exibicao },
  });
}

/**
 * Revoga a sessão corrente (specs/11 §2.3). Idempotente: token ausente, inválido
 * ou já revogado responde 204 do mesmo jeito — não é oráculo de validade.
 */
export async function DELETE(req: Request): Promise<Response> {
  const tenant = await exigirTenant();
  if (tenant instanceof Response) return tenant;

  const token = tokenDoHeader(req);
  if (token) {
    const ds = await obterAppDataSource();
    await encerrarSessao(ds, tenant.id, token).catch(() => {});
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
