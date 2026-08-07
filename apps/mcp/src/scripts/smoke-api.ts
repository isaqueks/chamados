/**
 * Smoke da API `/api/v1` + cliente MCP (specs/11), de ponta a ponta sobre HTTP.
 *
 * Prova, contra a aplicação REAL rodando:
 *  1. login por e-mail+senha devolve token; credencial errada → 401 genérico;
 *  2. Bearer autentica; SEM header e com COOKIE não autenticam (anti-CSRF §1.4);
 *  3. listagem filtra por status e recusa valor inválido (400, não "tudo");
 *  4. equipe lê a timeline COM notas internas; cliente NÃO as vê (§5);
 *  5. cliente não lê chamado de outro cliente (404, sem vazar existência);
 *  6. cliente é recusado ao tentar escrever nota interna (403);
 *  7. publicar mensagem e transicionar status funcionam e valem no banco;
 *  8. transição inválida é recusada pela máquina de estados (409);
 *  9. o cliente MCP (`ClienteChamados`) opera o mesmo fluxo e renova a sessão;
 * 10. logout revoga o token (401 depois).
 *
 * PRÉ-REQUISITOS: Postgres de pé (`docker compose up -d`), migrations aplicadas e
 * a aplicação web servindo (`npm run dev:web`). A URL vem de `SMOKE_API_URL`
 * (default `http://localhost:3000`). Cria um tenant descartável e o remove ao fim.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const {
  criarAppDataSource,
  criarAdminDataSource,
  runInTenantContext,
  provisionarTenant,
  criarUsuarioAtivoComSenha,
  criarChamado,
  criarMensagem,
  transicionarStatus,
  atorSistema,
} = await import('@chamados/db');
const { Papel, StatusTenant, StatusChamado, Natureza, VisibilidadeMensagem } =
  await import('@chamados/shared');
const { ClienteChamados } = await import('../cliente');

const BASE = (process.env.SMOKE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SENHA = 'Dev@12345';

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

interface Resposta<T = unknown> {
  status: number;
  corpo: T;
}

/** Chamada HTTP crua à API, com o slug do tenant no header (host é localhost). */
async function chamar<T = Record<string, unknown>>(
  slug: string,
  caminho: string,
  opts: { metodo?: string; token?: string; cookie?: string; corpo?: unknown } = {},
): Promise<Resposta<T>> {
  const headers: Record<string, string> = { 'x-tenant-slug': slug, accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.corpo !== undefined) headers['content-type'] = 'application/json';

  const resp = await fetch(`${BASE}${caminho}`, {
    method: opts.metodo ?? 'GET',
    headers,
    ...(opts.corpo !== undefined ? { body: JSON.stringify(opts.corpo) } : {}),
  });
  const texto = await resp.text();
  let corpo: unknown = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = texto;
  }
  return { status: resp.status, corpo: corpo as T };
}

async function main(): Promise<void> {
  // Confere que a aplicação está no ar antes de provisionar qualquer coisa.
  const saude = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!saude || !saude.ok) {
    throw new Error(
      `aplicação web não responde em ${BASE} — suba com "npm run dev:web" (ou defina SMOKE_API_URL).`,
    );
  }

  const ds = criarAppDataSource();
  await ds.initialize();
  console.log(`[smoke-api] conectado ao banco; API em ${BASE}`);

  const sufixo = randomUUID().slice(0, 8);
  const slug = `smoke-api-${sufixo}`;
  let tenantId = '';

  try {
    const prov = await provisionarTenant(ds, {
      slug,
      nome: 'Smoke API',
      nomeExibicao: 'Smoke API',
      status: StatusTenant.ativo,
    });
    tenantId = prov.tenant_id;

    // --- Massa de teste ----------------------------------------------------
    const { operadorEmail, clienteEmail, chamadoId, chamadoAlheioId } = await runInTenantContext(
      ds,
      tenantId,
      async (em) => {
        const operadorEmail = `op.${sufixo}@smoke.dev`;
        const clienteEmail = `cli.${sufixo}@smoke.dev`;
        const operadorId = await criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantId,
          email: operadorEmail,
          nome: 'Operadora Marina',
          papel: Papel.operador,
          senha: SENHA,
        });
        const clienteId = await criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantId,
          email: clienteEmail,
          nome: 'Cliente Ana',
          papel: Papel.cliente,
          senha: SENHA,
        });
        const outroId = await criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantId,
          email: `out.${sufixo}@smoke.dev`,
          nome: 'Cliente Outro',
          papel: Papel.cliente,
          senha: SENHA,
        });

        const atorCli = { id: clienteId, tenant_id: tenantId, papel: Papel.cliente };
        const criado = await criarChamado(em, atorCli, {
          titulo: 'Boleto nao gera segunda via',
          natureza: Natureza.problema,
          descricao: 'Ao clicar em gerar segunda via a tela fica em branco.',
        });
        if (!criado.ok) throw new Error(`criarChamado falhou: ${criado.motivo}`);

        const atorOutro = { id: outroId, tenant_id: tenantId, papel: Papel.cliente };
        const alheio = await criarChamado(em, atorOutro, {
          titulo: 'Chamado de outro cliente',
          natureza: Natureza.duvida,
          descricao: 'Conteudo que a Ana nunca pode ver.',
        });
        if (!alheio.ok) throw new Error(`criarChamado (alheio) falhou: ${alheio.motivo}`);

        // Nota interna existente: é o que o cliente NUNCA pode ver pela API.
        const atorOp = { id: operadorId, tenant_id: tenantId, papel: Papel.operador };
        const nota = await criarMensagem(em, atorOp, {
          chamado_id: criado.id,
          visibilidade: VisibilidadeMensagem.interna,
          corpo: 'Diagnostico interno: excecao no BoletoService, linha 88.',
        });
        if (!nota.ok) throw new Error(`nota interna falhou: ${nota.motivo}`);

        // Sai de `novo` para um estado onde as transições do teste são válidas.
        // `novo → em_triagem` é do ator SISTEMA (specs/04 §1.3); operador não pode.
        const t1 = await transicionarStatus(
          em,
          atorSistema(tenantId),
          criado.id,
          StatusChamado.em_triagem,
          { motivo: 'smoke' },
        );
        if (!t1.ok) throw new Error(`transição novo→em_triagem falhou: ${t1.motivo}`);
        const t2 = await transicionarStatus(em, atorOp, criado.id, StatusChamado.em_atendimento, {
          motivo: 'smoke',
        });
        if (!t2.ok) throw new Error(`transição em_triagem→em_atendimento falhou: ${t2.motivo}`);

        return {
          operadorEmail,
          clienteEmail,
          chamadoId: criado.id,
          chamadoAlheioId: alheio.id,
        };
      },
    );

    // --- 1) Login ----------------------------------------------------------
    const rLogin = await chamar<{ token: string; usuario: { papel: string } }>(
      slug,
      '/api/v1/sessao',
      { metodo: 'POST', corpo: { email: operadorEmail, senha: SENHA } },
    );
    ok(rLogin.status === 200, 'login do operador devolve 200');
    const tokenOp = rLogin.corpo.token;
    ok(typeof tokenOp === 'string' && tokenOp.length > 20, 'login devolve token opaco');
    ok(rLogin.corpo.usuario.papel === 'operador', 'login informa o papel do usuário');

    const rSenhaErrada = await chamar<{ codigo: string }>(slug, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: operadorEmail, senha: 'errada' },
    });
    ok(rSenhaErrada.status === 401, 'senha errada → 401');
    ok(rSenhaErrada.corpo.codigo === 'credenciais_invalidas', 'código de erro genérico');

    const rInexistente = await chamar<{ codigo: string }>(slug, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: `nao.existe.${sufixo}@smoke.dev`, senha: SENHA },
    });
    ok(
      rInexistente.status === 401 && rInexistente.corpo.codigo === 'credenciais_invalidas',
      'conta inexistente responde IGUAL a senha errada (anti-enumeração)',
    );

    // --- 2) Autenticação: Bearer sim, cookie não ---------------------------
    const semToken = await chamar<{ codigo: string }>(slug, '/api/v1/chamados');
    ok(semToken.status === 401, 'sem Authorization → 401');

    const comCookie = await chamar<{ codigo: string }>(slug, '/api/v1/chamados', {
      cookie: `chamados_sessao=${tokenOp}`,
    });
    ok(
      comCookie.status === 401,
      'cookie de sessão NÃO autentica a API (Bearer-only — anti-CSRF, specs/11 §1.4)',
    );

    const tokenLixo = await chamar(slug, '/api/v1/chamados', { token: 'token-invalido' });
    ok(tokenLixo.status === 401, 'token inválido → 401');

    // --- 3) Listagem e filtros --------------------------------------------
    const lista = await chamar<{ itens: Array<Record<string, unknown>> }>(
      slug,
      '/api/v1/chamados',
      { token: tokenOp },
    );
    ok(lista.status === 200, 'listagem autenticada → 200');
    ok(lista.corpo.itens.length === 2, 'operador enxerga os 2 chamados do tenant');

    const filtrada = await chamar<{ itens: Array<{ status: string }> }>(
      slug,
      '/api/v1/chamados?status=em_atendimento',
      { token: tokenOp },
    );
    ok(filtrada.corpo.itens.length === 1, 'filtro por status devolve só o chamado em atendimento');
    ok(filtrada.corpo.itens[0]!.status === 'em_atendimento', 'status do item bate com o filtro');

    const multi = await chamar<{ itens: unknown[] }>(
      slug,
      '/api/v1/chamados?status=em_atendimento,novo',
      { token: tokenOp },
    );
    ok(multi.corpo.itens.length === 2, 'filtro aceita lista de status');

    const invalida = await chamar<{ codigo: string }>(slug, '/api/v1/chamados?status=aberto', {
      token: tokenOp,
    });
    ok(
      invalida.status === 400 && invalida.corpo.codigo === 'parametro_invalido',
      'status inválido → 400 (nunca ignora o filtro e devolve tudo)',
    );

    // --- 4) Detalhe: equipe vê nota interna --------------------------------
    const detOp = await chamar<{
      chamado: Record<string, unknown>;
      mensagens: Array<{ visibilidade?: string; corpo: string }>;
    }>(slug, `/api/v1/chamados/${chamadoId}`, { token: tokenOp });
    ok(detOp.status === 200, 'detalhe por UUID → 200');
    ok(
      detOp.corpo.mensagens.some((m) => m.visibilidade === 'interna'),
      'operador recebe a NOTA INTERNA na timeline',
    );
    ok('complexidade' in detOp.corpo.chamado, 'operador recebe o campo interno complexidade');
    ok(
      typeof detOp.corpo.chamado.descricao === 'string' &&
        !(detOp.corpo.chamado.descricao as string).includes('<'),
      'descrição vem em texto puro (sem HTML)',
    );

    const numero = detOp.corpo.chamado.numero as number;
    const porNumero = await chamar<{ chamado: { id: string } }>(
      slug,
      `/api/v1/chamados/${numero}`,
      { token: tokenOp },
    );
    ok(
      porNumero.status === 200 && porNumero.corpo.chamado.id === chamadoId,
      'ref por NÚMERO resolve o mesmo chamado',
    );

    // --- 5) Fronteira do cliente ------------------------------------------
    const rLoginCli = await chamar<{ token: string }>(slug, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: clienteEmail, senha: SENHA },
    });
    const tokenCli = rLoginCli.corpo.token;

    const detCli = await chamar<{
      chamado: Record<string, unknown>;
      mensagens: Array<{ visibilidade?: string }>;
    }>(slug, `/api/v1/chamados/${chamadoId}`, { token: tokenCli });
    ok(detCli.status === 200, 'cliente lê o próprio chamado');
    ok(
      detCli.corpo.mensagens.every((m) => m.visibilidade === undefined),
      'cliente NÃO recebe nota interna nem o campo visibilidade',
    );
    ok(!('complexidade' in detCli.corpo.chamado), 'cliente NÃO recebe complexidade');
    ok(!('ia_silenciada' in detCli.corpo.chamado), 'cliente NÃO recebe ia_silenciada');

    const alheio = await chamar<{ codigo: string }>(slug, `/api/v1/chamados/${chamadoAlheioId}`, {
      token: tokenCli,
    });
    ok(
      alheio.status === 404 && alheio.corpo.codigo === 'chamado_inexistente',
      'cliente pedindo chamado de outro recebe 404 (não vaza existência)',
    );

    const listaCli = await chamar<{ itens: unknown[] }>(slug, '/api/v1/chamados', {
      token: tokenCli,
    });
    ok(listaCli.corpo.itens.length === 1, 'listagem do cliente traz só os próprios chamados');

    // --- 6) Escrita: fronteira de visibilidade -----------------------------
    const notaProibida = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoId}/mensagens`,
      { token: tokenCli, metodo: 'POST', corpo: { visibilidade: 'interna', corpo: 'tentativa' } },
    );
    ok(
      notaProibida.status === 403 && notaProibida.corpo.codigo === 'sem_permissao',
      'cliente NÃO escreve nota interna (403)',
    );

    // --- 7) Escrita válida -------------------------------------------------
    const publicada = await chamar<{ id: string }>(slug, `/api/v1/chamados/${numero}/mensagens`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { visibilidade: 'publica', corpo: 'Oi! Já estamos **analisando** seu chamado.' },
    });
    ok(publicada.status === 201 && !!publicada.corpo.id, 'operador publica mensagem pública (201)');

    const notaOp = await chamar<{ id: string }>(slug, `/api/v1/chamados/${numero}/mensagens`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { visibilidade: 'interna', corpo: 'Nota tecnica via API.' },
    });
    ok(notaOp.status === 201, 'operador publica nota interna (201)');

    const depois = await chamar<{ mensagens: Array<{ corpo: string; visibilidade?: string }> }>(
      slug,
      `/api/v1/chamados/${numero}`,
      { token: tokenOp },
    );
    ok(depois.corpo.mensagens.length === 3, 'timeline reflete as mensagens publicadas');
    ok(
      depois.corpo.mensagens.some((m) => m.corpo.includes('analisando')),
      'markdown virou conteúdo de verdade na timeline',
    );

    const cliDepois = await chamar<{ mensagens: Array<{ corpo: string }> }>(
      slug,
      `/api/v1/chamados/${numero}`,
      { token: tokenCli },
    );
    ok(
      cliDepois.corpo.mensagens.length === 1 &&
        cliDepois.corpo.mensagens[0]!.corpo.includes('analisando'),
      'cliente vê APENAS a mensagem pública recém-criada',
    );

    // --- 8) Status: válido e inválido --------------------------------------
    const invalidaTransicao = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${numero}/status`,
      { token: tokenOp, metodo: 'POST', corpo: { status: 'novo' } },
    );
    ok(
      invalidaTransicao.status === 409 && invalidaTransicao.corpo.codigo === 'transicao_invalida',
      'transição fora da máquina de estados → 409',
    );

    const statusRuim = await chamar<{ codigo: string }>(slug, `/api/v1/chamados/${numero}/status`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { status: 'concluido' },
    });
    ok(statusRuim.status === 400, 'status fora do enum → 400');

    const resolvido = await chamar<{ status: string }>(slug, `/api/v1/chamados/${numero}/status`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { status: 'resolvido', motivo: 'smoke' },
    });
    ok(
      resolvido.status === 200 && resolvido.corpo.status === 'resolvido',
      'operador resolve o chamado pela API',
    );

    const persistido = await runInTenantContext(ds, tenantId, async (em) => {
      const linhas: Array<{ status: string }> = await em.query(
        'SELECT status FROM chamado WHERE id = $1',
        [chamadoId],
      );
      return linhas[0]?.status;
    });
    ok(persistido === 'resolvido', 'a mudança está no BANCO (não só na resposta)');

    // --- 9) Cliente MCP sobre a mesma API ----------------------------------
    const mcp = new ClienteChamados({
      baseUrl: BASE,
      email: operadorEmail,
      senha: SENHA,
      tenantSlug: slug,
      somenteLeitura: false,
    });
    const viaMcp = await mcp.requisitar<{ itens: Array<{ numero: number }> }>('/api/v1/chamados', {
      query: { status: 'resolvido' },
    });
    ok(viaMcp.itens.length === 1, 'ClienteChamados (MCP) lista pela API real');
    ok(mcp.quemSou()?.papel === 'operador', 'ClienteChamados expõe a identidade autenticada');

    // --- 10) Logout revoga -------------------------------------------------
    const saida = await chamar(slug, '/api/v1/sessao', { metodo: 'DELETE', token: tokenOp });
    ok(saida.status === 204, 'logout responde 204');
    const depoisDoLogout = await chamar(slug, '/api/v1/chamados', { token: tokenOp });
    ok(depoisDoLogout.status === 401, 'token revogado não autentica mais');

    console.log('\n[smoke-api] RESULTADO: PASSOU — API /api/v1 e cliente MCP confirmados.');
  } finally {
    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      if (tenantId) {
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "sessao" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [tenantId]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [tenantId]);
      }
    } catch (e) {
      console.warn('[smoke-api] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(
    '\n[smoke-api] RESULTADO: FALHOU —',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
