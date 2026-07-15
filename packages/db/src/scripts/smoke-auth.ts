/**
 * Smoke test do subsistema de autenticação/perfis/permissões (specs/03).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) contra um tenant DESCARTÁVEL e prova,
 * ponta a ponta:
 *   1. provisiona tenant (agente_ia criado automaticamente);
 *   2. login do admin cria sessão server-side válida;
 *   3. admin cria convite (token único); cliente aceita e define senha;
 *   4. login do cliente cria sessão;
 *   5. a sessão do cliente NÃO acessa recurso de admin (authorize nega) e o
 *      admin acessa;
 *   6. logout revoga a sessão (o cookie deixa de resolver);
 *   7. reset de senha invalida todas as sessões da conta.
 * Ao final, limpa o tenant de teste.
 *
 * Sai com 0 se tudo passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource, criarAdminDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const {
  provisionarTenant,
  resolverTenantPorSlug,
  autenticarComSenha,
  carregarSessao,
  encerrarSessao,
  criarConvite,
  aceitarConvite,
  criarUsuarioAtivoComSenha,
  solicitarRedefinicao,
  redefinirComToken,
} = await import('../auth');
const { autorizar } = await import('@chamados/shared');
const { Papel, StatusTenant } = await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-auth] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  const slug = `smoke-auth-${sufixo}`;
  const emailAdmin = `admin.${sufixo}@smoke.dev`;
  const emailCliente = `cliente.${sufixo}@smoke.dev`;
  const SENHA = 'Sm0ke!teste';
  const SENHA_NOVA = 'Sm0ke!nova99';
  let tenantId = '';

  try {
    // 1) Provisiona tenant descartável + admin ativo -----------------------
    const prov = await provisionarTenant(ds, {
      slug,
      nome: 'Smoke Auth',
      nomeExibicao: 'Smoke Auth',
      status: StatusTenant.ativo,
    });
    tenantId = prov.tenant_id;
    ok(!!prov.agente_ia_id, 'provisionamento criou o service account agente_ia');

    await runInTenantContext(ds, tenantId, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantId,
        email: emailAdmin,
        nome: 'Admin Smoke',
        papel: Papel.admin,
        senha: SENHA,
      }),
    );

    const tenant = await resolverTenantPorSlug(ds, slug);
    ok(!!tenant && tenant.id === tenantId, 'resolveu o tenant por slug (SECURITY DEFINER)');

    // 2) Login do admin cria sessão válida ---------------------------------
    const loginAdmin = await autenticarComSenha(ds, tenant!, {
      email: emailAdmin,
      senha: SENHA,
    });
    ok(loginAdmin.ok, 'login do admin com credencial correta: OK');
    const loginErrado = await autenticarComSenha(ds, tenant!, {
      email: emailAdmin,
      senha: 'errada',
    });
    ok(!loginErrado.ok, 'login com senha errada é negado (resposta genérica)');

    if (!loginAdmin.ok) throw new Error('login admin falhou');
    const admin = loginAdmin.usuario;
    const sessaoAdmin = await carregarSessao(ds, tenantId, loginAdmin.token);
    ok(sessaoAdmin?.id === admin.id, 'cookie do admin resolve a sessão do admin');

    // 3) Admin cria convite; cliente aceita --------------------------------
    const conv = await runInTenantContext(ds, tenantId, (em) =>
      criarConvite(em, {
        tenant_id: tenantId,
        email: emailCliente,
        papel: Papel.cliente,
        criado_por: admin.id,
      }),
    );
    ok(conv.ok, 'admin criou convite de cliente (token único)');
    if (!conv.ok) throw new Error('convite falhou');

    const aceite = await runInTenantContext(ds, tenantId, (em) =>
      aceitarConvite(em, conv.token, { nome: 'Cliente Smoke', senha: SENHA }),
    );
    ok(aceite.ok, 'cliente aceitou o convite e definiu senha (conta ativa)');
    const aceiteRepetido = await runInTenantContext(ds, tenantId, (em) =>
      aceitarConvite(em, conv.token, { nome: 'X', senha: SENHA }),
    );
    ok(!aceiteRepetido.ok, 'convite é de uso único (segundo aceite negado)');

    // 4) Login do cliente ---------------------------------------------------
    const loginCliente = await autenticarComSenha(ds, tenant!, {
      email: emailCliente,
      senha: SENHA,
    });
    ok(loginCliente.ok, 'login do cliente recém-criado: OK');
    if (!loginCliente.ok) throw new Error('login cliente falhou');
    const cliente = loginCliente.usuario;
    ok(cliente.papel === Papel.cliente, 'papel do cliente é `cliente`');

    // 5) Autorização: cliente NÃO acessa recurso de admin ------------------
    ok(
      autorizar(cliente, 'usuario', 'listar') === false,
      'authorize NEGA cliente listar usuários (recurso de admin)',
    );
    ok(
      autorizar(cliente, 'mensagem_interna', 'ler') === false,
      'authorize NEGA cliente ler nota interna',
    );
    ok(autorizar(admin, 'usuario', 'listar') === true, 'authorize PERMITE admin listar usuários');

    // 6) Logout revoga a sessão --------------------------------------------
    await encerrarSessao(ds, tenantId, loginCliente.token);
    const depoisLogout = await carregarSessao(ds, tenantId, loginCliente.token);
    ok(depoisLogout === null, 'logout invalida a sessão (cookie não resolve mais)');

    // 7) Reset de senha invalida todas as sessões --------------------------
    const loginAdmin2 = await autenticarComSenha(ds, tenant!, {
      email: emailAdmin,
      senha: SENHA,
    });
    if (!loginAdmin2.ok) throw new Error('re-login admin falhou');
    const pedido = await solicitarRedefinicao(ds, tenantId, emailAdmin);
    ok(!!pedido, 'reset gera token para conta existente');
    const semConta = await solicitarRedefinicao(ds, tenantId, 'ninguem@smoke.dev');
    ok(semConta === null, 'reset para e-mail inexistente não gera token (genérico)');

    const red = await redefinirComToken(ds, tenantId, pedido!.token, SENHA_NOVA);
    ok(red.ok, 'redefinição de senha com token válido: OK');
    const sessaoAposReset = await carregarSessao(ds, tenantId, loginAdmin2.token);
    ok(sessaoAposReset === null, 'reset de senha invalidou as sessões ativas do admin');
    const loginSenhaNova = await autenticarComSenha(ds, tenant!, {
      email: emailAdmin,
      senha: SENHA_NOVA,
    });
    ok(loginSenhaNova.ok, 'admin loga com a nova senha');

    console.log('\n[smoke-auth] RESULTADO: PASSOU — fluxo de auth confirmado.');
  } finally {
    // Limpeza do tenant descartável (role admin p/ apagar tudo do tenant).
    if (tenantId) {
      const admin = criarAdminDataSource();
      await admin.initialize();
      try {
        await admin.query(`DELETE FROM "redefinicao_senha" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "sessao" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "convite" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [tenantId]);
      } catch (e) {
        console.warn('[smoke-auth] aviso: limpeza parcial:', e);
      } finally {
        await admin.destroy();
      }
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-auth] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
