/**
 * Smoke de HARDENING DE SEGURANÇA (M10 frente B — specs/09, specs/03).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) contra tenants DESCARTÁVEIS e prova:
 *   1. Rate limiting (Redis): N tentativas → bloqueio → mensagem genérica;
 *      quando a janela expira, volta a liberar. Fail-open sem quebrar o fluxo.
 *   2. Webhook anti-SSRF: URL privada/interna é REJEITADA no salvamento e o
 *      validador aceita pública / bloqueia loopback, RFC1918, metadata, ::1.
 *   3. Sessão: o login ROTACIONA o token (dois logins → tokens distintos e
 *      independentes — anti-fixation); ambos resolvem e são revogáveis.
 *   4. Anexo cross-tenant: anexo de nota interna negado ao cliente; anexo de
 *      outro tenant é inexistente (RLS).
 *
 * Requer Postgres + Redis de pé. Sai com 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource, criarAdminDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const {
  provisionarTenant,
  resolverTenantPorSlug,
  criarUsuarioAtivoComSenha,
  autenticarComSenha,
  carregarSessao,
  encerrarSessao,
} = await import('../auth');
const { aplicarLimite, consumirRateLimit, mensagemRateLimit, fecharRateLimit } =
  await import('../rate-limit');
const { validarUrlWebhook, salvarWebhook, buscarCanal, WebhookUrlInvalidaError } =
  await import('../notificacoes');
const { criarSecretStore } = await import('../secrets/secret-store');
const { CanalNotificacaoTipo } = await import('../notificacoes/tipos');
const { criarChamado } = await import('../chamados/chamado-service');
const { criarMensagem } = await import('../chamados/mensagem-service');
const { autorizarDownloadAnexo } = await import('../chamados/anexo-service');
const { AnexoSchema } = await import('../entities/anexo');
const { Papel, StatusTenant, Natureza, VisibilidadeMensagem } = await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-seguranca] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  try {
    // ---------------------------------------------------------------------
    // 1) Rate limiting (Redis) — bloqueio + expiração de janela
    // ---------------------------------------------------------------------
    console.log('\n[1] Rate limiting');
    const alvo = `smoke:${sufixo}`;
    for (let i = 1; i <= 3; i++) {
      const r = await aplicarLimite('smoke-rl', alvo, 3, 1);
      ok(r.ok, `tentativa ${i}/3 dentro do limite: liberada`);
    }
    const estouro = await aplicarLimite('smoke-rl', alvo, 3, 1);
    ok(!estouro.ok, '4ª tentativa: BLOQUEADA (limite excedido)');
    ok(estouro.retryAposS > 0, 'bloqueio informa retryAposS > 0');
    ok(mensagemRateLimit(estouro.retryAposS).length > 0, 'mensagem genérica amigável disponível');

    await sleep(1300); // deixa a janela (1s) expirar
    const aposJanela = await aplicarLimite('smoke-rl', alvo, 3, 1);
    ok(aposJanela.ok, 'após a janela expirar: volta a LIBERAR');

    const folgado = await consumirRateLimit('login', {
      tenantId: 't-fake',
      ip: '203.0.113.7',
      email: 'ninguem@ex.dev',
    });
    ok(folgado.ok, 'consumirRateLimit(login) com uso normal: NÃO bloqueia (folgado)');

    // ---------------------------------------------------------------------
    // Provisiona tenants descartáveis
    // ---------------------------------------------------------------------
    const provA = await provisionarTenant(ds, {
      slug: `smoke-sec-a-${sufixo}`,
      nome: 'Sec A',
      nomeExibicao: 'Sec A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-sec-b-${sufixo}`,
      nome: 'Sec B',
      nomeExibicao: 'Sec B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    // ---------------------------------------------------------------------
    // 2) Webhook anti-SSRF
    // ---------------------------------------------------------------------
    console.log('\n[2] Webhook anti-SSRF');
    for (const u of [
      'http://localhost/hook',
      'http://127.0.0.1/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/hook',
      'http://192.168.0.9/hook',
      'http://[::1]/hook',
    ]) {
      ok(!validarUrlWebhook(u, { permitirPrivado: false }).ok, `validador REJEITA ${u}`);
    }
    ok(
      validarUrlWebhook('https://webhooks.exemplo.com/chamados', { permitirPrivado: false }).ok,
      'validador ACEITA URL pública https',
    );
    ok(
      validarUrlWebhook('http://localhost:4000/hook', { permitirPrivado: true }).ok,
      'flag de dev libera host privado (localhost)',
    );

    // Salvamento: URL privada é bloqueada (fail-closed); pública persiste.
    let bloqueouNoSalvamento = false;
    try {
      await runInTenantContext(ds, tenantA, (em) =>
        salvarWebhook(
          em,
          tenantA,
          { url: 'http://169.254.169.254/x', ativo: false },
          criarSecretStore(),
        ),
      );
    } catch (e) {
      bloqueouNoSalvamento = e instanceof WebhookUrlInvalidaError;
    }
    ok(bloqueouNoSalvamento, 'salvarWebhook LANÇA em URL privada (SSRF) — nunca persiste');

    await runInTenantContext(ds, tenantA, (em) =>
      salvarWebhook(
        em,
        tenantA,
        { url: 'https://webhooks.exemplo.com/chamados', ativo: false },
        criarSecretStore(),
      ),
    );
    const canal = await runInTenantContext(ds, tenantA, (em) =>
      buscarCanal(em, CanalNotificacaoTipo.webhook),
    );
    ok(
      canal?.config?.url === 'https://webhooks.exemplo.com/chamados',
      'salvarWebhook PERSISTE URL pública',
    );

    // ---------------------------------------------------------------------
    // 3) Sessão — rotação de token no login (anti-fixation)
    // ---------------------------------------------------------------------
    console.log('\n[3] Sessão / rotação de token');
    const emailAdmin = `admin.${sufixo}@a.dev`;
    const SENHA = 'Sm0ke!teste';
    await runInTenantContext(ds, tenantA, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: emailAdmin,
        nome: 'Admin Sec',
        papel: Papel.admin,
        senha: SENHA,
      }),
    );
    const tenantResolvido = await resolverTenantPorSlug(ds, `smoke-sec-a-${sufixo}`);
    if (!tenantResolvido) throw new Error('não resolveu tenant A por slug');
    const l1 = await autenticarComSenha(ds, tenantResolvido, { email: emailAdmin, senha: SENHA });
    const l2 = await autenticarComSenha(ds, tenantResolvido, { email: emailAdmin, senha: SENHA });
    ok(l1.ok && l2.ok, 'dois logins válidos sucedem');
    if (!l1.ok || !l2.ok) throw new Error('login falhou');
    ok(l1.token !== l2.token, 'cada login gera um TOKEN NOVO (rotação — anti-fixation)');
    const s1 = await carregarSessao(ds, tenantA, l1.token);
    const s2 = await carregarSessao(ds, tenantA, l2.token);
    ok(!!s1 && !!s2, 'ambos os tokens resolvem sessões válidas e independentes');
    await encerrarSessao(ds, tenantA, l1.token);
    const s1Depois = await carregarSessao(ds, tenantA, l1.token);
    const s2Depois = await carregarSessao(ds, tenantA, l2.token);
    ok(s1Depois === null && !!s2Depois, 'revogar uma sessão NÃO afeta a outra (isolamento)');

    // ---------------------------------------------------------------------
    // 4) Anexo cross-tenant + visibilidade interna
    // ---------------------------------------------------------------------
    console.log('\n[4] Anexo — autorização e isolamento');
    const { clienteA, operadorA } = await runInTenantContext(ds, tenantA, async (em) => {
      const clienteA = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Cliente A',
        papel: Papel.cliente,
        senha: SENHA,
      });
      const operadorA = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Operador A',
        papel: Papel.operador,
        senha: SENHA,
      });
      return { clienteA, operadorA };
    });
    const clienteB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `cli.${sufixo}@b.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: SENHA,
      }),
    );

    const atorCliA = { id: clienteA, tenant_id: tenantA, papel: Papel.cliente };
    const atorOpA = { id: operadorA, tenant_id: tenantA, papel: Papel.operador };
    const atorCliB = { id: clienteB, tenant_id: tenantB, papel: Papel.cliente };

    const { anexoPublicoId, anexoInternoId } = await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await criarChamado(em, atorCliA, {
        titulo: 'Chamado de teste seguranca',
        descricao: 'Descrição em texto simples (sem imagem).',
        natureza: Natureza.problema,
      });
      if (!ch.ok) throw new Error('falha ao criar chamado');
      const msgInterna = await criarMensagem(em, atorOpA, {
        chamado_id: ch.id,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'Nota interna com anexo sensível.',
      });
      if (!msgInterna.ok) throw new Error('falha ao criar nota interna');

      // Anexo público (na descrição do chamado) e anexo interno (na nota) —
      // inseridos diretamente (sem MinIO): a autorização é lógica pura de BD.
      const pubId = randomUUID();
      const intId = randomUUID();
      await em.insert(AnexoSchema, {
        id: pubId,
        tenant_id: tenantA,
        chamado_id: ch.id,
        mensagem_id: null,
        nome_arquivo: 'publico.pdf',
        content_type: 'application/pdf',
        tamanho_bytes: '10',
        storage_key: `tenants/${tenantA}/anexos/${ch.id}/${pubId}`,
        checksum_sha256: null,
        inline: false,
      });
      await em.insert(AnexoSchema, {
        id: intId,
        tenant_id: tenantA,
        chamado_id: null,
        mensagem_id: msgInterna.id,
        nome_arquivo: 'interno.log',
        content_type: 'text/plain',
        tamanho_bytes: '10',
        storage_key: `tenants/${tenantA}/anexos/${ch.id}/${intId}`,
        checksum_sha256: null,
        inline: false,
      });
      return { anexoPublicoId: pubId, anexoInternoId: intId };
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const pubCli = await autorizarDownloadAnexo(em, atorCliA, anexoPublicoId);
      ok(pubCli.ok, 'cliente dono BAIXA anexo público do próprio chamado');
      const intCli = await autorizarDownloadAnexo(em, atorCliA, anexoInternoId);
      ok(!intCli.ok, 'cliente NÃO baixa anexo de NOTA INTERNA (403/404)');
      const intOp = await autorizarDownloadAnexo(em, atorOpA, anexoInternoId);
      ok(intOp.ok, 'operador BAIXA anexo de nota interna');
    });

    await runInTenantContext(ds, tenantB, async (em) => {
      const cross1 = await autorizarDownloadAnexo(em, atorCliB, anexoPublicoId);
      const cross2 = await autorizarDownloadAnexo(em, atorCliB, anexoInternoId);
      ok(!cross1.ok, 'tenant B NÃO baixa anexo público do tenant A (RLS → inexistente)');
      ok(!cross2.ok, 'tenant B NÃO baixa anexo interno do tenant A (RLS → inexistente)');
    });

    console.log('\n[smoke-seguranca] RESULTADO: PASSOU — hardening confirmado.');
  } finally {
    await fecharRateLimit();
    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "canal_notificacao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "sessao" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-seguranca] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-seguranca] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
