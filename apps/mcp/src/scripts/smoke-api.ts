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
      if (tenantId) {
        await admin.query(`DELETE FROM "anexo" WHERE tenant_id = $1`, [tenantId]);
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
