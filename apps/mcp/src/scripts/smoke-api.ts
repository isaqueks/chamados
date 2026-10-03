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
 * 10. logout revoga o token (401 depois);
 * 11. criação de chamado (D-032): operador precisa de solicitante, cliente abre
 *     para si (e não pode indicar solicitante), enum inválido é 400, o registro
 *     vale no banco e `GET /sistemas-alvo` informa se o alvo é obrigatório;
 * 12. anexos e formato (D-035): o detalhe lista imagens inline e arquivos por
 *     mensagem, `formato=markdown|html` preserva as imagens apontando para a
 *     rota Bearer, `GET /anexos/{id}` entrega os bytes com o tipo pinado e a
 *     fronteira vale (cliente não baixa anexo de nota interna nem de outro).
 * 13. extensões da Forja (D-036): L1 silenciar/reativar a IA (idempotente, sem
 *     evento na repetição), L2 ids de equipe na projeção, L3 filtro
 *     `complexidade` e L4 atribuição — com o cliente recusado (403, sem vazar
 *     existência) e o ISOLAMENTO CROSS-TENANT provado contra um segundo tenant
 *     com o MESMO número de chamado: o token de A nunca enxerga nem altera B.
 *
 * Requer também o MinIO de pé (os anexos vão para o storage).
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
  definirComplexidade,
  atorSistema,
} = await import('@chamados/db');
const { Papel, StatusTenant, StatusChamado, Natureza, VisibilidadeMensagem, Complexidade } =
  await import('@chamados/shared');
const { ClienteChamados } = await import('@chamados/cliente-api');

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
  let tenantBId = '';

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

    // --- 11) Criação de chamado (specs/11 §4.5/§4.6, D-032) ----------------
    const semSolicitante = await chamar<{ codigo: string }>(slug, '/api/v1/chamados', {
      token: tokenOp,
      metodo: 'POST',
      corpo: { titulo: 'Impressora parou', descricao: 'Nao imprime desde ontem.' },
    });
    ok(
      semSolicitante.status === 400 && semSolicitante.corpo.codigo === 'parametro_invalido',
      'operador sem solicitante → 400 (abre EM NOME DE um cliente)',
    );

    const solicitanteRuim = await chamar<{ codigo: string }>(slug, '/api/v1/chamados', {
      token: tokenOp,
      metodo: 'POST',
      corpo: {
        titulo: 'Impressora parou',
        descricao: 'Nao imprime.',
        solicitante_email: operadorEmail, // existe, mas NÃO é cliente
      },
    });
    ok(
      solicitanteRuim.status === 400 && solicitanteRuim.corpo.codigo === 'parametro_invalido',
      'solicitante que não é cliente → 400',
    );

    const naturezaRuim = await chamar<{ codigo: string }>(slug, '/api/v1/chamados', {
      token: tokenOp,
      metodo: 'POST',
      corpo: {
        titulo: 'Impressora parou',
        descricao: 'Nao imprime.',
        natureza: 'bug',
        solicitante_email: clienteEmail,
      },
    });
    ok(naturezaRuim.status === 400, 'natureza fora do enum → 400 (nunca ignorada)');

    const criadoOp = await chamar<{ id: string; numero: number }>(slug, '/api/v1/chamados', {
      token: tokenOp,
      metodo: 'POST',
      corpo: {
        titulo: 'Impressora parou',
        descricao: 'Nao imprime **desde ontem**.\n\n- fila travada\n- luz laranja',
        natureza: 'problema',
        prioridade: 'alta',
        solicitante_email: clienteEmail.toUpperCase(), // e-mail é normalizado
      },
    });
    ok(
      criadoOp.status === 201 && typeof criadoOp.corpo.numero === 'number',
      'operador abre chamado em nome do cliente (201 + número)',
    );

    const linhaOp = await runInTenantContext(ds, tenantId, async (em) => {
      const linhas: Array<{ email: string; natureza: string; prioridade: string; html: string }> =
        await em.query(
          `SELECT u.email, c.natureza, c.prioridade, c.descricao_html AS html
             FROM chamado c JOIN usuario u ON u.id = c.cliente_id WHERE c.id = $1`,
          [criadoOp.corpo.id],
        );
      return linhas[0];
    });
    ok(linhaOp?.email === clienteEmail, 'o SOLICITANTE gravado é o cliente do e-mail informado');
    ok(
      linhaOp?.natureza === 'problema' && linhaOp?.prioridade === 'alta',
      'natureza e prioridade informadas valem no banco',
    );
    ok(
      !!linhaOp && linhaOp.html.includes('<strong>') && linhaOp.html.includes('<li>'),
      'markdown da descrição virou HTML sanitizado',
    );

    const criadoCli = await chamar<{ id: string; numero: number }>(slug, '/api/v1/chamados', {
      token: tokenCli,
      metodo: 'POST',
      corpo: { titulo: 'Como exporto o relatorio?', descricao: 'Nao acho o botao.' },
    });
    ok(criadoCli.status === 201, 'cliente abre chamado para si sem natureza (201)');
    const linhaCli = await runInTenantContext(ds, tenantId, async (em) => {
      const linhas: Array<{ email: string; natureza: string; prioridade: string }> = await em.query(
        `SELECT u.email, c.natureza, c.prioridade
             FROM chamado c JOIN usuario u ON u.id = c.cliente_id WHERE c.id = $1`,
        [criadoCli.corpo.id],
      );
      return linhas[0];
    });
    ok(linhaCli?.email === clienteEmail, 'chamado do cliente tem ELE como solicitante');
    ok(
      linhaCli?.natureza === 'problema' && linhaCli?.prioridade === 'media',
      'defaults: natureza "problema" (D-017) e prioridade "media"',
    );

    const cliComSolicitante = await chamar<{ codigo: string }>(slug, '/api/v1/chamados', {
      token: tokenCli,
      metodo: 'POST',
      corpo: { titulo: 'Tentativa', descricao: 'x', solicitante_email: `out.${sufixo}@smoke.dev` },
    });
    ok(
      cliComSolicitante.status === 403 && cliComSolicitante.corpo.codigo === 'sem_permissao',
      'cliente NÃO abre chamado em nome de outro (403)',
    );

    const sistemas = await chamar<{ sistemas: unknown[]; sistema_alvo_obrigatorio: boolean }>(
      slug,
      '/api/v1/sistemas-alvo',
      { token: tokenCli },
    );
    ok(
      sistemas.status === 200 &&
        Array.isArray(sistemas.corpo.sistemas) &&
        sistemas.corpo.sistema_alvo_obrigatorio === false,
      'GET /sistemas-alvo responde e informa que o alvo NÃO é obrigatório (tenant sem sistemas)',
    );

    // --- 12) Anexos e formato (specs/11 §4.2/§4.7, D-035) ------------------
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const { chamadoImgId, notaAnexoId } = await runInTenantContext(ds, tenantId, async (em) => {
      const cli = (await em.query('SELECT id FROM usuario WHERE email = $1', [clienteEmail]))[0]
        .id as string;
      const op = (await em.query('SELECT id FROM usuario WHERE email = $1', [operadorEmail]))[0]
        .id as string;
      const atorCli = { id: cli, tenant_id: tenantId, papel: Papel.cliente };
      const atorOp = { id: op, tenant_id: tenantId, papel: Papel.operador };
      const criado = await criarChamado(em, atorCli, {
        titulo: 'Tela de erro com print',
        natureza: Natureza.problema,
        descricao: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Aparece ' },
                { type: 'text', text: 'isto', marks: [{ type: 'bold' }] },
                { type: 'text', text: ': ' },
                {
                  type: 'image',
                  attrs: { src: `data:image/png;base64,${PNG.toString('base64')}`, alt: 'print' },
                },
              ],
            },
          ],
        },
      });
      if (!criado.ok) throw new Error(`criarChamado (imagem) falhou: ${criado.motivo}`);
      const publica = await criarMensagem(em, atorCli, {
        chamado_id: criado.id,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: 'Segue o print em anexo.',
        anexos: [{ nome_arquivo: 'print.png', buffer: PNG }],
      });
      if (!publica.ok) throw new Error(`mensagem com anexo falhou: ${publica.motivo}`);
      const nota = await criarMensagem(em, atorOp, {
        chamado_id: criado.id,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'Evidencia interna.',
        anexos: [{ nome_arquivo: 'interno.png', buffer: PNG }],
      });
      if (!nota.ok) throw new Error(`nota com anexo falhou: ${nota.motivo}`);
      const linhas: Array<{ id: string }> = await em.query(
        'SELECT id FROM anexo WHERE mensagem_id = $1',
        [nota.id],
      );
      return { chamadoImgId: criado.id, notaAnexoId: linhas[0]!.id };
    });

    type Anx = {
      id: string;
      inline: boolean;
      nome_arquivo: string;
      content_type: string;
      url: string;
    };
    type Det = {
      chamado: { descricao: string; formato: string; anexos: Anx[] };
      mensagens: Array<{ visibilidade?: string; corpo: string; anexos: Anx[] }>;
    };
    const detImg = await chamar<Det>(slug, `/api/v1/chamados/${chamadoImgId}`, { token: tokenOp });
    ok(
      detImg.status === 200 && detImg.corpo.chamado.formato === 'texto',
      'detalhe default é formato texto',
    );
    ok(
      detImg.corpo.chamado.anexos.length === 1 && detImg.corpo.chamado.anexos[0]!.inline === true,
      'imagem colada na descrição aparece em chamado.anexos com inline=true',
    );
    ok(!detImg.corpo.chamado.descricao.includes('<'), 'texto continua sem HTML');
    const msgPub = detImg.corpo.mensagens.find((m) => m.visibilidade === 'publica');
    ok(
      msgPub?.anexos.length === 1 &&
        msgPub.anexos[0]!.nome_arquivo === 'print.png' &&
        !msgPub.anexos[0]!.inline,
      'anexo da mensagem pública aparece em mensagens[].anexos',
    );
    ok(
      detImg.corpo.mensagens.some(
        (m) => m.visibilidade === 'interna' && m.anexos.some((a) => a.id === notaAnexoId),
      ),
      'operador vê o anexo da nota interna',
    );
    const inlineId = detImg.corpo.chamado.anexos[0]!.id;
    ok(
      detImg.corpo.chamado.anexos[0]!.url === `/api/v1/anexos/${inlineId}`,
      'anexo traz a url Bearer',
    );

    const detMd = await chamar<Det>(slug, `/api/v1/chamados/${chamadoImgId}?formato=markdown`, {
      token: tokenOp,
    });
    ok(
      detMd.corpo.chamado.formato === 'markdown' &&
        detMd.corpo.chamado.descricao.includes('**isto**') &&
        detMd.corpo.chamado.descricao.includes(`![print](/api/v1/anexos/${inlineId})`),
      'formato=markdown preserva ênfase e a imagem no lugar, apontando para a rota Bearer',
    );
    const detHtml = await chamar<Det>(slug, `/api/v1/chamados/${chamadoImgId}?formato=html`, {
      token: tokenOp,
    });
    ok(
      detHtml.corpo.chamado.descricao.includes(`<img src="/api/v1/anexos/${inlineId}"`),
      'formato=html reescreve a src da imagem para a rota Bearer',
    );
    const fmtRuim = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoImgId}?formato=xml`,
      { token: tokenOp },
    );
    ok(
      fmtRuim.status === 400 && fmtRuim.corpo.codigo === 'parametro_invalido',
      'formato inválido → 400',
    );

    const detCliImg = await chamar<Det>(slug, `/api/v1/chamados/${chamadoImgId}`, {
      token: tokenCli,
    });
    ok(
      detCliImg.corpo.mensagens.every((m) => m.anexos.every((a) => a.id !== notaAnexoId)),
      'cliente NÃO vê o anexo da nota interna',
    );

    const bytes = await fetch(`${BASE}/api/v1/anexos/${inlineId}`, {
      headers: { 'x-tenant-slug': slug, authorization: `Bearer ${tokenOp}` },
    });
    const corpoBytes = Buffer.from(await bytes.arrayBuffer());
    ok(
      bytes.status === 200 &&
        bytes.headers.get('content-type') === 'image/png' &&
        corpoBytes.equals(PNG),
      'GET /anexos/{id} entrega os bytes com o content-type pinado',
    );
    ok(
      (bytes.headers.get('content-disposition') ?? '').startsWith('inline;') &&
        bytes.headers.get('x-content-type-options') === 'nosniff',
      'cabeçalhos seguros (disposition + nosniff)',
    );
    const bytesCli = await fetch(`${BASE}/api/v1/anexos/${inlineId}`, {
      headers: { 'x-tenant-slug': slug, authorization: `Bearer ${tokenCli}` },
    });
    ok(bytesCli.status === 200, 'cliente baixa anexo do próprio chamado');
    const internoCli = await chamar<{ codigo: string }>(slug, `/api/v1/anexos/${notaAnexoId}`, {
      token: tokenCli,
    });
    ok(
      internoCli.status === 404 && internoCli.corpo.codigo === 'anexo_inexistente',
      'cliente NÃO baixa anexo de nota interna (404, sem vazar existência)',
    );
    const rLoginOutro = await chamar<{ token: string }>(slug, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: `out.${sufixo}@smoke.dev`, senha: SENHA },
    });
    const outroBaixa = await chamar(slug, `/api/v1/anexos/${inlineId}`, {
      token: rLoginOutro.corpo.token,
    });
    ok(outroBaixa.status === 404, 'outro cliente NÃO baixa anexo de chamado alheio (404)');
    const semAuth = await chamar(slug, `/api/v1/anexos/${inlineId}`);
    ok(semAuth.status === 401, 'anexo sem Bearer → 401');

    // --- 13) Extensões da Forja (specs/11 §4.8/§4.9, D-036 L1–L4) ---------
    // Tenant B com o MESMO número de chamado que A: prova que a resolução de
    // `{ref}` por número, as mutações novas e a busca do operador alvo rodam
    // escopadas pela RLS — o token de A não alcança B nem por UUID nem por número.
    const provB = await provisionarTenant(ds, {
      slug: `${slug}-b`,
      nome: 'Smoke API B',
      nomeExibicao: 'Smoke API B',
      status: StatusTenant.ativo,
    });
    tenantBId = provB.tenant_id;
    const massaB = await runInTenantContext(ds, tenantBId, async (em) => {
      const opB = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantBId,
        email: `opb.${sufixo}@smoke.dev`,
        nome: 'Operador B',
        papel: Papel.operador,
        senha: SENHA,
      });
      const cliB = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantBId,
        email: `clib.${sufixo}@smoke.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: SENHA,
      });
      const criado = await criarChamado(
        em,
        { id: cliB, tenant_id: tenantBId, papel: Papel.cliente },
        { titulo: 'Chamado do tenant B', natureza: Natureza.problema, descricao: 'Segredo de B.' },
      );
      if (!criado.ok) throw new Error(`criarChamado (B) falhou: ${criado.motivo}`);
      const cx = await definirComplexidade(
        em,
        { id: opB, tenant_id: tenantBId, papel: Papel.operador },
        criado.id,
        Complexidade.facil,
      );
      if (!cx.ok) throw new Error(`definirComplexidade (B) falhou: ${cx.motivo}`);
      const linhas: Array<{ numero: string; categoria_id: string | null }> = await em.query(
        'SELECT numero, categoria_id FROM chamado WHERE id = $1',
        [criado.id],
      );
      return {
        opBId: opB,
        chamadoBId: criado.id,
        numeroB: Number(linhas[0]!.numero),
        categoriaBId: linhas[0]!.categoria_id,
      };
    });
    ok(massaB.numeroB === numero, `tenant B tem um chamado com o MESMO número (#${numero}) de A`);

    const massaA = await runInTenantContext(ds, tenantId, async (em) => {
      const id = async (email: string) =>
        (await em.query('SELECT id FROM usuario WHERE email = $1', [email]))[0].id as string;
      const opAId = await id(operadorEmail);
      const cliAId = await id(clienteEmail);
      const atorOp = { id: opAId, tenant_id: tenantId, papel: Papel.operador };
      const cx = await definirComplexidade(em, atorOp, chamadoId, Complexidade.facil);
      if (!cx.ok) throw new Error(`definirComplexidade (A) falhou: ${cx.motivo}`);
      // Operador SUSPENSO: existe e é da equipe, mas não pode receber chamado.
      const suspensoId = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantId,
        email: `susp.${sufixo}@smoke.dev`,
        nome: 'Operador Suspenso',
        papel: Papel.operador,
        senha: SENHA,
      });
      await em.query(`UPDATE usuario SET status = 'suspenso' WHERE id = $1`, [suspensoId]);
      // Chamado terminal: `novo → cancelado` é permitido ao operador.
      const term = await criarChamado(
        em,
        { id: cliAId, tenant_id: tenantId, papel: Papel.cliente },
        { titulo: 'Chamado que sera cancelado', natureza: Natureza.duvida, descricao: 'x' },
      );
      if (!term.ok) throw new Error(`criarChamado (terminal) falhou: ${term.motivo}`);
      const canc = await transicionarStatus(em, atorOp, term.id, StatusChamado.cancelado, {
        motivo: 'smoke',
      });
      if (!canc.ok) throw new Error(`cancelamento falhou: ${canc.motivo}`);
      return { opAId, cliAId, suspensoId, terminalId: term.id };
    });

    /** Lê (no tenant indicado) os campos que as rotas novas mudam. */
    const lerChamado = (tid: string, id: string) =>
      runInTenantContext(ds, tid, async (em) => {
        const l: Array<{ ia_silenciada: boolean; operador_id: string | null }> = await em.query(
          'SELECT ia_silenciada, operador_id FROM chamado WHERE id = $1',
          [id],
        );
        return l[0]!;
      });
    const contarEventos = (id: string, tipo: string) =>
      runInTenantContext(ds, tenantId, async (em) => {
        const l: Array<{ n: string }> = await em.query(
          'SELECT count(*) AS n FROM evento_chamado WHERE chamado_id = $1 AND tipo = $2',
          [id, tipo],
        );
        return Number(l[0]!.n);
      });

    type ItemL = Record<string, unknown> & { id: string };

    // L1 — silenciar/reativar a IA ------------------------------------------
    const silPorNumero = await chamar<{ ia_silenciada: boolean }>(
      slug,
      `/api/v1/chamados/${numero}/ia`,
      { token: tokenOp, metodo: 'POST', corpo: { silenciada: true } },
    );
    ok(
      silPorNumero.status === 200 && silPorNumero.corpo.ia_silenciada === true,
      'L1: operador silencia a IA pelo NÚMERO (200)',
    );
    ok(
      (await lerChamado(tenantId, chamadoId)).ia_silenciada === true &&
        (await lerChamado(tenantBId, massaB.chamadoBId)).ia_silenciada === false,
      'L1: mesmo número em A e B → só o chamado de A mudou (RLS na resolução do {ref})',
    );
    const eventosSil = await contarEventos(chamadoId, 'ia_silenciada');
    const silDeNovo = await chamar(slug, `/api/v1/chamados/${chamadoId}/ia`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { silenciada: true },
    });
    ok(
      silDeNovo.status === 200 && (await contarEventos(chamadoId, 'ia_silenciada')) === eventosSil,
      'L1: repetir o mesmo valor → 200 e NENHUM evento novo (idempotente)',
    );
    const listaSil = await chamar<{ itens: ItemL[] }>(slug, '/api/v1/chamados', {
      token: tokenOp,
    });
    ok(
      listaSil.corpo.itens.find((i) => i.id === chamadoId)?.ia_silenciada === true,
      'L1: ia_silenciada vem no ITEM da lista da equipe',
    );
    const silB = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaB.chamadoBId}/ia`,
      { token: tokenOp, metodo: 'POST', corpo: { silenciada: true } },
    );
    ok(
      silB.status === 404 && silB.corpo.codigo === 'chamado_inexistente',
      'L1: token de A com o UUID de um chamado de B → 404',
    );
    const silCli = await chamar<{ codigo: string }>(slug, `/api/v1/chamados/${chamadoId}/ia`, {
      token: tokenCli,
      metodo: 'POST',
      corpo: { silenciada: false },
    });
    ok(
      silCli.status === 403 && silCli.corpo.codigo === 'sem_permissao',
      'L1: cliente (mesmo dono do chamado) → 403',
    );
    const silCliInexistente = await chamar(slug, '/api/v1/chamados/999999/ia', {
      token: tokenCli,
      metodo: 'POST',
      corpo: { silenciada: false },
    });
    ok(
      silCliInexistente.status === 403,
      'L1: cliente recebe 403 também para chamado inexistente (não vaza existência)',
    );
    const silTerm = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaA.terminalId}/ia`,
      { token: tokenOp, metodo: 'POST', corpo: { silenciada: true } },
    );
    ok(
      silTerm.status === 409 && silTerm.corpo.codigo === 'estado_terminal',
      'L1: chamado terminal → 409 estado_terminal',
    );
    const silRuim = await chamar<{ codigo: string }>(slug, `/api/v1/chamados/${chamadoId}/ia`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { silenciada: 'sim' },
    });
    ok(
      silRuim.status === 400 && silRuim.corpo.codigo === 'parametro_invalido',
      'L1: "silenciada" não booleana → 400 parametro_invalido',
    );
    const reativa = await chamar<{ ia_silenciada: boolean }>(
      slug,
      `/api/v1/chamados/${chamadoId}/ia`,
      { token: tokenOp, metodo: 'POST', corpo: { silenciada: false } },
    );
    ok(
      reativa.status === 200 &&
        reativa.corpo.ia_silenciada === false &&
        (await contarEventos(chamadoId, 'ia_reativada')) === 1,
      'L1: reativar → 200 e um evento ia_reativada',
    );

    // L2 — ids de equipe na projeção ----------------------------------------
    const CAMPOS_L2 = ['sistema_alvo_id', 'categoria_id', 'operador_id'] as const;
    const listaL2 = await chamar<{ itens: ItemL[] }>(slug, '/api/v1/chamados?limite=100', {
      token: tokenOp,
    });
    ok(
      listaL2.corpo.itens.length > 0 &&
        listaL2.corpo.itens.every((i) => CAMPOS_L2.every((c) => c in i) && 'ia_silenciada' in i),
      'L2: todo item da lista da equipe traz sistema_alvo_id, categoria_id, operador_id e ia_silenciada',
    );
    ok(
      listaL2.corpo.itens.every(
        (i) =>
          i.id !== massaB.chamadoBId &&
          (massaB.categoriaBId === null || i.categoria_id !== massaB.categoriaBId) &&
          i.operador_id !== massaB.opBId,
      ),
      'L2: a lista de A nunca traz chamado nem ids de B',
    );
    const detL2 = await chamar<{ chamado: Record<string, unknown> }>(
      slug,
      `/api/v1/chamados/${chamadoId}`,
      { token: tokenOp },
    );
    ok(
      CAMPOS_L2.every((c) => c in detL2.corpo.chamado),
      'L2: o detalhe da equipe traz os mesmos ids',
    );
    const listaCliL2 = await chamar<{ itens: ItemL[] }>(slug, '/api/v1/chamados', {
      token: tokenCli,
    });
    const detCliL2 = await chamar<{ chamado: Record<string, unknown> }>(
      slug,
      `/api/v1/chamados/${chamadoId}`,
      { token: tokenCli },
    );
    ok(
      listaCliL2.corpo.itens.length > 0 &&
        [...listaCliL2.corpo.itens, detCliL2.corpo.chamado].every(
          (i) => CAMPOS_L2.every((c) => !(c in i)) && !('ia_silenciada' in i),
        ),
      'L2: lista e detalhe do CLIENTE não trazem ids de equipe nem ia_silenciada',
    );

    // L3 — filtro complexidade ----------------------------------------------
    const facil = await chamar<{ itens: ItemL[] }>(slug, '/api/v1/chamados?complexidade=facil', {
      token: tokenOp,
    });
    // A triagem do servidor pode classificar em paralelo os chamados abertos pela
    // API nas seções anteriores: as asserções valem para QUALQUER conjunto.
    ok(
      facil.status === 200 &&
        facil.corpo.itens.some((i) => i.id === chamadoId) &&
        facil.corpo.itens.every((i) => i.complexidade === 'facil' && i.id !== massaB.chamadoBId),
      'L3: ?complexidade=facil em A traz o "facil" de A e só "facil" — nunca o de B (também "facil")',
    );
    const semFacil = await chamar<{ itens: ItemL[] }>(
      slug,
      '/api/v1/chamados?complexidade=medio,dificil',
      { token: tokenOp },
    );
    ok(
      semFacil.status === 200 &&
        semFacil.corpo.itens.every(
          (i) => (i.complexidade === 'medio' || i.complexidade === 'dificil') && i.id !== chamadoId,
        ),
      'L3: CSV de valores aceito; o que não casa (inclusive complexidade null) fica de fora',
    );
    const cxRuim = await chamar<{ codigo: string }>(slug, '/api/v1/chamados?complexidade=xyz', {
      token: tokenOp,
    });
    ok(
      cxRuim.status === 400 && cxRuim.corpo.codigo === 'parametro_invalido',
      'L3: complexidade fora do enum → 400',
    );
    const cxCli = await chamar<{ codigo: string }>(slug, '/api/v1/chamados?complexidade=facil', {
      token: tokenCli,
    });
    ok(
      cxCli.status === 403 && cxCli.corpo.codigo === 'sem_permissao',
      'L3: cliente filtrando por complexidade → 403 (o resultado revelaria o campo)',
    );

    // L4 — atribuição ---------------------------------------------------------
    const atrib = await chamar<{ operador_id: string | null }>(
      slug,
      `/api/v1/chamados/${numero}/atribuicao`,
      { token: tokenOp, metodo: 'POST', corpo: { operador_id: massaA.opAId } },
    );
    ok(
      atrib.status === 200 && atrib.corpo.operador_id === massaA.opAId,
      'L4: operador se atribui pelo NÚMERO (200)',
    );
    ok(
      (await lerChamado(tenantId, chamadoId)).operador_id === massaA.opAId &&
        (await lerChamado(tenantBId, massaB.chamadoBId)).operador_id === null,
      'L4: vale no banco de A; o chamado de MESMO número em B segue sem operador',
    );
    const listaAtrib = await chamar<{ itens: ItemL[] }>(slug, '/api/v1/chamados', {
      token: tokenOp,
    });
    ok(
      listaAtrib.corpo.itens.find((i) => i.id === chamadoId)?.operador_id === massaA.opAId,
      'L4 + L2: a lista reflete o operador_id atribuído',
    );
    for (const [alvo, rotulo] of [
      [massaB.opBId, 'operador de OUTRO tenant (a busca roda sob RLS)'],
      [massaA.cliAId, 'usuário com papel cliente'],
      [massaA.suspensoId, 'operador suspenso'],
      [randomUUID(), 'UUID inexistente'],
    ] as const) {
      const r = await chamar<{ codigo: string }>(slug, `/api/v1/chamados/${chamadoId}/atribuicao`, {
        token: tokenOp,
        metodo: 'POST',
        corpo: { operador_id: alvo },
      });
      ok(r.status === 400 && r.corpo.codigo === 'parametro_invalido', `L4: ${rotulo} → 400`);
    }
    ok(
      (await lerChamado(tenantId, chamadoId)).operador_id === massaA.opAId,
      'L4: tentativas recusadas não mexeram na atribuição',
    );
    const semChave = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoId}/atribuicao`,
      { token: tokenOp, metodo: 'POST', corpo: {} },
    );
    ok(
      semChave.status === 400 && semChave.corpo.codigo === 'parametro_invalido',
      'L4: corpo sem "operador_id" → 400 (nunca desatribui por omissão)',
    );
    const atribB = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaB.chamadoBId}/atribuicao`,
      { token: tokenOp, metodo: 'POST', corpo: { operador_id: massaA.opAId } },
    );
    ok(
      atribB.status === 404 && atribB.corpo.codigo === 'chamado_inexistente',
      'L4: token de A com o UUID de um chamado de B → 404',
    );
    const atribCli = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoId}/atribuicao`,
      { token: tokenCli, metodo: 'POST', corpo: { operador_id: null } },
    );
    ok(atribCli.status === 403 && atribCli.corpo.codigo === 'sem_permissao', 'L4: cliente → 403');
    const atribTerm = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaA.terminalId}/atribuicao`,
      { token: tokenOp, metodo: 'POST', corpo: { operador_id: massaA.opAId } },
    );
    ok(
      atribTerm.status === 409 && atribTerm.corpo.codigo === 'estado_terminal',
      'L4: chamado terminal → 409 estado_terminal',
    );
    const desatrib = await chamar<{ operador_id: string | null }>(
      slug,
      `/api/v1/chamados/${chamadoId}/atribuicao`,
      { token: tokenOp, metodo: 'POST', corpo: { operador_id: null } },
    );
    ok(
      desatrib.status === 200 &&
        desatrib.corpo.operador_id === null &&
        (await lerChamado(tenantId, chamadoId)).operador_id === null,
      'L4: operador_id null desatribui (200, vale no banco)',
    );

    // --- 9) Cliente MCP sobre a mesma API ----------------------------------
    const mcp = new ClienteChamados({
      baseUrl: BASE,
      email: operadorEmail,
      obterSenha: () => SENHA,
      tenantSlug: slug,
    });
    const viaMcp = await mcp.requisitar<{ itens: Array<{ numero: number }> }>('/api/v1/chamados', {
      query: { status: 'resolvido' },
    });
    ok(viaMcp.itens.length === 1, 'ClienteChamados (MCP) lista pela API real');
    ok(mcp.quemSou()?.papel === 'operador', 'ClienteChamados expõe a identidade autenticada');
    const viaMcpBytes = await mcp.requisitarBytes(`/api/v1/anexos/${inlineId}`);
    ok(
      viaMcpBytes.corpo.equals(PNG) && viaMcpBytes.contentType === 'image/png',
      'ClienteChamados.requisitarBytes baixa o anexo pela API real',
    );

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
      for (const tid of [tenantId, tenantBId].filter((t) => t.length > 0)) {
        await admin.query(`DELETE FROM "anexo" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "sessao" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [tid]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [tid]);
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
