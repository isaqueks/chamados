/**
 * Smoke da API `/api/v1` + cliente MCP (specs/11), de ponta a ponta sobre HTTP.
 *
 * Prova, contra a aplicação REAL rodando:
 *  1. login por e-mail+senha devolve token; credencial errada → 401 genérico;
 *  2. Bearer autentica; SEM header e com COOKIE não autenticam (anti-CSRF §1.4);
 *  3. listagem filtra por status e recusa valor inválido (400, não "tudo");
 *  4. equipe lê a timeline COM notas internas; cliente NÃO as vê (§5);
 *  5. D-037: cliente LÊ chamado de outro cliente do MESMO tenant só na visão
 *     pública (sem nota interna/complexidade/operador), lista o tenant, recorta
 *     com `meus=true` e NÃO escreve/transiciona o chamado alheio (403);
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
 *     fronteira vale (cliente não baixa anexo de nota interna; anexo público de
 *     chamado alheio do mesmo tenant sim — D-037).
 * 13. extensões da Forja (D-036): L1 silenciar/reativar a IA (idempotente, sem
 *     evento na repetição), L2 ids de equipe na projeção, L3 filtro
 *     `complexidade` e L4 atribuição — com o cliente recusado (403, sem vazar
 *     existência) e o ISOLAMENTO CROSS-TENANT provado contra um segundo tenant
 *     com o MESMO número de chamado: o token de A nunca enxerga nem altera B.
 * 14. reabertura de encerrado (D-038): `POST …/status {em_atendimento}` reabre
 *     `fechado` e `cancelado` pelo operador (qualquer chamado) e pelo cliente
 *     DONO; cliente não-dono → 403; encerrado continua recusando mensagem e
 *     qualquer outra transição (409 `estado_terminal`); o token de A não reabre
 *     o cancelado de B (404).
 * 15. "quem responde fica responsável" (D-039): `POST …/mensagens` pública de
 *     operador atribui o chamado a ele (evento `operador_atribuido` com motivo
 *     `resposta_publica`, sem duplicar na segunda resposta); nota interna e
 *     mensagem do `agente_ia` não atribuem; um segundo operador que responde (e
 *     move para `aguardando_cliente`, como a Forja faz) assume; o token do
 *     tenant B não responde nem reatribui o chamado de A (404).
 * 16. custo (D-043): `POST …/custo` — cliente 403 antes de resolver o `{ref}`;
 *     estimativa definida (idempotente), corpo vazio/código inválido 400; custo
 *     final fora de `resolvido` → 409 `custo_fora_da_resolucao` (e a estimativa
 *     enviada junto é desfeita — transação única); `POST …/status` com
 *     `custo_final` só em `resolvido` (400 em outra transição); lista e detalhe
 *     trazem `estimativa_custo`/`custo_final` para o cliente; correção grava
 *     evento; o token de B não alcança A e vice-versa (404).
 * 17. upload multipart (D-046): cliente abre chamado com print (imagem na
 *     descrição); operador responde com 1 imagem posicionada por marcador +
 *     1 PDF (imagem aparece no `formato=markdown` apontando para
 *     `/api/v1/anexos/…`, PDF como anexo comum); SVG/EXE → 415 e NADA publicado
 *     (nem mensagem nem linha de anexo); arquivo > 25 MB → 413; cliente dono
 *     anexa no próprio chamado; cliente NÃO-dono → 403 em chamado alheio, sem
 *     efeito; o token de B não baixa o anexo nem publica em A (404); o
 *     `ClienteChamados.publicarMensagemComArquivos` funciona contra a API real.
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
          // D-037: a Ana LÊ este chamado (visão pública), mas não age nele.
          descricao: 'Chamado de um colega da Ana no mesmo tenant.',
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
        // Nota interna também no chamado ALHEIO: a leitura ampliada (D-037) não
        // pode trazê-la ao cliente.
        const notaAlheia = await criarMensagem(em, atorOp, {
          chamado_id: alheio.id,
          visibilidade: VisibilidadeMensagem.interna,
          corpo: 'Bastidor do chamado alheio: nunca vai a cliente.',
        });
        if (!notaAlheia.ok) throw new Error(`nota interna (alheio) falhou: ${notaAlheia.motivo}`);
        const pubAlheia = await criarMensagem(em, atorOp, {
          chamado_id: alheio.id,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Resposta publica ao colega.',
        });
        if (!pubAlheia.ok) throw new Error(`mensagem publica (alheio) falhou: ${pubAlheia.motivo}`);

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

    // D-037: o cliente LÊ o chamado de outro cliente do mesmo tenant, só na
    // visão pública (sem nota interna, complexidade, operador, flag da IA).
    const alheio = await chamar<{
      chamado: Record<string, unknown>;
      mensagens: Array<{ visibilidade?: string; corpo: string }>;
    }>(slug, `/api/v1/chamados/${chamadoAlheioId}`, { token: tokenCli });
    ok(alheio.status === 200, 'cliente lê o chamado de OUTRO cliente do mesmo tenant (D-037)');
    ok(
      alheio.corpo.mensagens.length === 1 &&
        alheio.corpo.mensagens.every(
          (m) => m.visibilidade === undefined && !m.corpo.includes('Bastidor'),
        ),
      'chamado alheio: só a mensagem pública — nenhuma nota interna nem o campo visibilidade',
    );
    ok(
      ['complexidade', 'operador_nome', 'operador_id', 'ia_silenciada'].every(
        (c) => !(c in alheio.corpo.chamado),
      ),
      'chamado alheio: sem complexidade/operador/ia_silenciada na projeção do cliente',
    );
    ok(
      alheio.corpo.chamado.solicitante_nome === 'Cliente Outro',
      'chamado alheio: traz o nome do solicitante (dado público da visão do cliente)',
    );

    const listaCli = await chamar<{ itens: Array<{ id: string }> }>(slug, '/api/v1/chamados', {
      token: tokenCli,
    });
    ok(
      listaCli.corpo.itens.some((i) => i.id === chamadoId) &&
        listaCli.corpo.itens.some((i) => i.id === chamadoAlheioId),
      'listagem do cliente traz os chamados do TENANT (próprio + alheio — D-037)',
    );
    const listaMeus = await chamar<{ itens: Array<{ id: string }> }>(
      slug,
      '/api/v1/chamados?meus=true',
      { token: tokenCli },
    );
    ok(
      listaMeus.corpo.itens.length === 1 && listaMeus.corpo.itens[0]!.id === chamadoId,
      '`meus=true` recorta para os chamados em que o cliente é o solicitante',
    );
    const meusInvalido = await chamar<{ codigo: string }>(slug, '/api/v1/chamados?meus=sim', {
      token: tokenCli,
    });
    ok(
      meusInvalido.status === 400 && meusInvalido.corpo.codigo === 'parametro_invalido',
      '`meus` fora de true/false → 400',
    );

    // Ler ≠ agir: no chamado alheio o cliente não escreve nem transiciona.
    const escreveAlheio = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoAlheioId}/mensagens`,
      { token: tokenCli, metodo: 'POST', corpo: { visibilidade: 'publica', corpo: 'eu tambem' } },
    );
    ok(
      escreveAlheio.status === 403 && escreveAlheio.corpo.codigo === 'sem_permissao',
      'cliente NÃO publica mensagem no chamado alheio (403)',
    );
    const cancelaAlheio = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${chamadoAlheioId}/status`,
      { token: tokenCli, metodo: 'POST', corpo: { status: 'cancelado' } },
    );
    ok(
      cancelaAlheio.status === 403 && cancelaAlheio.corpo.codigo === 'sem_permissao',
      'cliente NÃO transiciona o chamado alheio (403)',
    );

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
    ok(
      outroBaixa.status === 200,
      'outro cliente do MESMO tenant baixa anexo PÚBLICO de chamado alheio (D-037)',
    );
    const outroInterno = await chamar(slug, `/api/v1/anexos/${notaAnexoId}`, {
      token: rLoginOutro.corpo.token,
    });
    ok(outroInterno.status === 404, 'outro cliente NÃO baixa anexo de nota interna alheia (404)');
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

    // --- 14) Reabertura de encerrado (D-038) -------------------------------
    const massaR = await runInTenantContext(ds, tenantId, async (em) => {
      const idPorEmail = async (email: string) =>
        (await em.query('SELECT id FROM usuario WHERE email = $1', [email]))[0].id as string;
      const outroId = await idPorEmail(`out.${sufixo}@smoke.dev`);
      const atorOp = { id: massaA.opAId, tenant_id: tenantId, papel: Papel.operador };
      const atorAna = { id: massaA.cliAId, tenant_id: tenantId, papel: Papel.cliente };
      const atorOutro = { id: outroId, tenant_id: tenantId, papel: Papel.cliente };
      const novo = async (ator: typeof atorAna, titulo: string) => {
        const c = await criarChamado(em, ator, {
          titulo,
          natureza: Natureza.problema,
          descricao: 'Massa da reabertura (D-038).',
        });
        if (!c.ok) throw new Error(`criarChamado (${titulo}) falhou: ${c.motivo}`);
        return c.id;
      };
      const passo = async (
        ator: Parameters<typeof transicionarStatus>[1],
        id: string,
        para: (typeof StatusChamado)[keyof typeof StatusChamado],
      ) => {
        const t = await transicionarStatus(em, ator, id, para, { motivo: 'smoke' });
        if (!t.ok) throw new Error(`transição → ${para} falhou: ${t.motivo}`);
      };
      // Fechado da Ana: novo → em_triagem → em_atendimento → resolvido → fechado.
      const fechadoId = await novo(atorAna, 'Reabrir fechado (D-038)');
      await passo(atorSistema(tenantId), fechadoId, StatusChamado.em_triagem);
      await passo(atorOp, fechadoId, StatusChamado.em_atendimento);
      await passo(atorOp, fechadoId, StatusChamado.resolvido);
      await passo(atorOp, fechadoId, StatusChamado.fechado);
      // Cancelado da Ana (ela mesma cancelou) e cancelado do "Cliente Outro".
      const canceladoId = await novo(atorAna, 'Reabrir cancelado (D-038)');
      await passo(atorAna, canceladoId, StatusChamado.cancelado);
      const alheioCanceladoId = await novo(atorOutro, 'Cancelado de outro cliente (D-038)');
      await passo(atorOutro, alheioCanceladoId, StatusChamado.cancelado);
      return { fechadoId, canceladoId, alheioCanceladoId };
    });
    const canceladoBId = await runInTenantContext(ds, tenantBId, async (em) => {
      const cliB = (
        await em.query('SELECT id FROM usuario WHERE email = $1', [`clib.${sufixo}@smoke.dev`])
      )[0].id as string;
      const atorCliB = { id: cliB, tenant_id: tenantBId, papel: Papel.cliente };
      const c = await criarChamado(em, atorCliB, {
        titulo: 'Cancelado do tenant B (D-038)',
        natureza: Natureza.problema,
        descricao: 'Ninguém de A reabre isto.',
      });
      if (!c.ok) throw new Error(`criarChamado (B, cancelado) falhou: ${c.motivo}`);
      const t = await transicionarStatus(em, atorCliB, c.id, StatusChamado.cancelado);
      if (!t.ok) throw new Error(`cancelamento (B) falhou: ${t.motivo}`);
      return c.id;
    });

    /** Estado persistido do chamado (no tenant indicado) que a reabertura mexe. */
    const lerReabertura = (tid: string, id: string) =>
      runInTenantContext(ds, tid, async (em) => {
        const l: Array<{ status: string; reaberto_count: number; fechado_em: Date | null }> =
          await em.query('SELECT status, reaberto_count, fechado_em FROM chamado WHERE id = $1', [
            id,
          ]);
        return l[0]!;
      });
    const reabrir = (id: string, token: string) =>
      chamar<{ status?: string; codigo?: string }>(slug, `/api/v1/chamados/${id}/status`, {
        token,
        metodo: 'POST',
        corpo: { status: 'em_atendimento', motivo: 'smoke D-038' },
      });

    // Encerrado continua encerrado para tudo que não é reabrir.
    const msgFechado = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaR.fechadoId}/mensagens`,
      { token: tokenOp, metodo: 'POST', corpo: { visibilidade: 'publica', corpo: 'oi' } },
    );
    ok(
      msgFechado.status === 409 && msgFechado.corpo.codigo === 'estado_terminal',
      'D-038: fechado continua recusando mensagem (409 estado_terminal)',
    );
    const outraSaida = await chamar<{ codigo: string }>(
      slug,
      `/api/v1/chamados/${massaR.fechadoId}/status`,
      { token: tokenOp, metodo: 'POST', corpo: { status: 'resolvido' } },
    );
    ok(
      outraSaida.status === 409 && outraSaida.corpo.codigo === 'estado_terminal',
      'D-038: fechado → resolvido continua 409 estado_terminal (só reabrir sai)',
    );

    // Cliente NÃO-dono não reabre (lê, mas não age — D-037).
    const naoDono = await reabrir(massaR.alheioCanceladoId, tokenCli);
    ok(
      naoDono.status === 403 && naoDono.corpo.codigo === 'sem_permissao',
      'D-038: cliente NÃO reabre o cancelado de outro cliente (403)',
    );

    // Cliente dono reabre o fechado; operador reabre de novo após novo ciclo.
    const anaFechado = await reabrir(massaR.fechadoId, tokenCli);
    const estF1 = await lerReabertura(tenantId, massaR.fechadoId);
    ok(
      anaFechado.status === 200 &&
        anaFechado.corpo.status === 'em_atendimento' &&
        estF1.status === 'em_atendimento' &&
        estF1.reaberto_count === 1 &&
        estF1.fechado_em === null,
      'D-038: cliente dono reabre FECHADO (200; banco: em_atendimento, count 1, fechado_em limpo)',
    );
    ok(
      (await contarEventos(massaR.fechadoId, 'chamado_reaberto')) === 1,
      'D-038: evento chamado_reaberto registrado na reabertura do fechado',
    );
    for (const para of ['resolvido', 'fechado']) {
      const r = await chamar(slug, `/api/v1/chamados/${massaR.fechadoId}/status`, {
        token: tokenOp,
        metodo: 'POST',
        corpo: { status: para },
      });
      ok(r.status === 200, `D-038: operador leva o reaberto a ${para} de novo`);
    }
    const opFechado = await reabrir(massaR.fechadoId, tokenOp);
    ok(
      opFechado.status === 200 &&
        (await lerReabertura(tenantId, massaR.fechadoId)).reaberto_count === 2,
      'D-038: operador reabre FECHADO (200, count 2)',
    );

    // Operador reabre cancelado (inclusive de outro cliente); dono também reabre.
    const opCancelado = await reabrir(massaR.canceladoId, tokenOp);
    ok(
      opCancelado.status === 200 &&
        (await lerReabertura(tenantId, massaR.canceladoId)).status === 'em_atendimento',
      'D-038: operador reabre CANCELADO (200)',
    );
    const opAlheio = await reabrir(massaR.alheioCanceladoId, tokenOp);
    ok(opAlheio.status === 200, 'D-038: operador reabre QUALQUER chamado do tenant (200)');
    const recancela = await chamar(slug, `/api/v1/chamados/${massaR.canceladoId}/status`, {
      token: tokenOp,
      metodo: 'POST',
      corpo: { status: 'cancelado' },
    });
    ok(recancela.status === 200, 'D-038: operador cancela de novo');
    const anaCancelado = await reabrir(massaR.canceladoId, tokenCli);
    const estC = await lerReabertura(tenantId, massaR.canceladoId);
    ok(
      anaCancelado.status === 200 && estC.status === 'em_atendimento' && estC.reaberto_count === 2,
      'D-038: cliente dono reabre CANCELADO (200, count 2)',
    );

    // Cross-tenant (regra 6): token de A com o UUID de um cancelado de B.
    const cross = await reabrir(canceladoBId, tokenOp);
    ok(
      cross.status === 404 && cross.corpo.codigo === 'chamado_inexistente',
      'D-038: token de A NÃO reabre cancelado do tenant B (404)',
    );
    const crossCli = await reabrir(canceladoBId, tokenCli);
    ok(crossCli.status === 404, 'D-038: cliente de A também recebe 404 no chamado de B');
    ok(
      (await lerReabertura(tenantBId, canceladoBId)).status === 'cancelado',
      'D-038: o chamado de B continua cancelado no banco',
    );

    // --- 15) Quem responde fica responsável (D-039) -------------------------
    const massaD = await runInTenantContext(ds, tenantId, async (em) => {
      const op2Email = `op2.${sufixo}@smoke.dev`;
      const op2Id = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantId,
        email: op2Email,
        nome: 'Operador Bruno',
        papel: Papel.operador,
        senha: SENHA,
      });
      const atorAna = { id: massaA.cliAId, tenant_id: tenantId, papel: Papel.cliente };
      const atorOp = { id: massaA.opAId, tenant_id: tenantId, papel: Papel.operador };
      const c = await criarChamado(em, atorAna, {
        titulo: 'Quem responde assume (D-039)',
        natureza: Natureza.problema,
        descricao: 'Massa da auto-atribuição por resposta.',
      });
      if (!c.ok) throw new Error(`criarChamado (D-039) falhou: ${c.motivo}`);
      const t1 = await transicionarStatus(
        em,
        atorSistema(tenantId),
        c.id,
        StatusChamado.em_triagem,
      );
      if (!t1.ok) throw new Error(`transição (D-039) → em_triagem falhou: ${t1.motivo}`);
      const t2 = await transicionarStatus(em, atorOp, c.id, StatusChamado.em_atendimento);
      if (!t2.ok) throw new Error(`transição (D-039) → em_atendimento falhou: ${t2.motivo}`);
      return { chamadoDId: c.id, op2Id, op2Email };
    });
    const idD = massaD.chamadoDId;
    const responder = (token: string, visibilidade: string, corpo: string, id = idD) =>
      chamar<{ id?: string; codigo?: string }>(slug, `/api/v1/chamados/${id}/mensagens`, {
        token,
        metodo: 'POST',
        corpo: { visibilidade, corpo },
      });
    const eventosAtrib = (tid: string, id: string) =>
      runInTenantContext(ds, tid, async (em) => {
        const l: Array<{ ator_id: string | null; dados: Record<string, unknown> }> = await em.query(
          `SELECT ator_id, dados FROM evento_chamado
              WHERE chamado_id = $1 AND tipo = 'operador_atribuido'
              ORDER BY created_at, id`,
          [id],
        );
        return l;
      });

    ok(
      (await lerChamado(tenantId, idD)).operador_id === null,
      'D-039: chamado nasce sem responsável',
    );

    const notaD = await responder(tokenOp, 'interna', 'Nota interna: investigando.');
    ok(
      notaD.status === 201 && (await lerChamado(tenantId, idD)).operador_id === null,
      'D-039: nota interna via API NÃO atribui',
    );

    // agente_ia não tem token na API: a regra vale no serviço (mesma função da rota).
    await runInTenantContext(ds, tenantId, async (em) => {
      const r = await criarMensagem(
        em,
        { id: prov.agente_ia_id, tenant_id: tenantId, papel: Papel.agente_ia },
        { chamado_id: idD, visibilidade: VisibilidadeMensagem.publica, corpo: 'Resposta da IA.' },
      );
      if (!r.ok) throw new Error(`mensagem da IA (D-039) falhou: ${r.motivo}`);
    });
    ok(
      (await lerChamado(tenantId, idD)).operador_id === null,
      'D-039: mensagem pública do agente_ia NÃO atribui',
    );

    const pubD = await responder(tokenOp, 'publica', 'Olá! Vou cuidar do seu chamado.');
    const evD1 = await eventosAtrib(tenantId, idD);
    ok(
      pubD.status === 201 && (await lerChamado(tenantId, idD)).operador_id === massaA.opAId,
      'D-039: resposta PÚBLICA do operador via API o torna responsável',
    );
    ok(
      evD1.length === 1 &&
        evD1[0]!.ator_id === massaA.opAId &&
        evD1[0]!.dados.operador_novo === massaA.opAId &&
        evD1[0]!.dados.operador_anterior === null &&
        evD1[0]!.dados.motivo === 'resposta_publica',
      'D-039: evento operador_atribuido (ator = autor, motivo resposta_publica)',
    );
    const pubD2 = await responder(tokenOp, 'publica', 'Mais um detalhe para você.');
    ok(
      pubD2.status === 201 && (await eventosAtrib(tenantId, idD)).length === 1,
      'D-039: o responsável responder de novo NÃO duplica o evento',
    );

    // Segundo operador responde e pergunta ao cliente (fluxo da Forja: pública →
    // status aguardando_cliente): assume no lugar do primeiro.
    const loginOp2 = await chamar<{ token: string }>(slug, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: massaD.op2Email, senha: SENHA },
    });
    ok(loginOp2.status === 200, 'D-039: login do segundo operador');
    const tokenOp2 = loginOp2.corpo.token;
    const pubOp2 = await responder(tokenOp2, 'publica', 'Pode me confirmar a versão do app?');
    const aguardar = await chamar<{ status?: string }>(slug, `/api/v1/chamados/${idD}/status`, {
      token: tokenOp2,
      metodo: 'POST',
      corpo: { status: 'aguardando_cliente', motivo: 'smoke D-039' },
    });
    const evD3 = await eventosAtrib(tenantId, idD);
    ok(
      pubOp2.status === 201 &&
        aguardar.status === 200 &&
        (await lerChamado(tenantId, idD)).operador_id === massaD.op2Id,
      'D-039: segundo operador que responde ASSUME (e a transição segue normal)',
    );
    ok(
      evD3.length === 2 &&
        evD3[1]!.dados.operador_anterior === massaA.opAId &&
        evD3[1]!.dados.operador_novo === massaD.op2Id,
      'D-039: evento registra a troca de responsável (anterior → novo)',
    );
    const detCliD = await chamar<{ chamado: Record<string, unknown> }>(
      slug,
      `/api/v1/chamados/${idD}`,
      { token: tokenCli },
    );
    ok(
      detCliD.status === 200 && !('operador_id' in detCliD.corpo.chamado),
      'D-039: o cliente continua sem ver o responsável',
    );

    // Cross-tenant (regra 6): token do operador de B contra o UUID de A, e o
    // token de A contra o chamado de B — nada responde, nada é reatribuído.
    const loginOpB = await chamar<{ token: string }>(`${slug}-b`, '/api/v1/sessao', {
      metodo: 'POST',
      corpo: { email: `opb.${sufixo}@smoke.dev`, senha: SENHA },
    });
    ok(loginOpB.status === 200, 'D-039: login do operador do tenant B');
    const crossD = await chamar<{ codigo: string }>(
      `${slug}-b`,
      `/api/v1/chamados/${idD}/mensagens`,
      {
        token: loginOpB.corpo.token,
        metodo: 'POST',
        corpo: { visibilidade: 'publica', corpo: 'Tentativa cross-tenant.' },
      },
    );
    ok(
      crossD.status === 404 && crossD.corpo.codigo === 'chamado_inexistente',
      'D-039: operador de B não responde o chamado de A (404)',
    );
    ok(
      (await lerChamado(tenantId, idD)).operador_id === massaD.op2Id,
      'D-039: responsável do chamado de A intacto após a tentativa de B',
    );
    const crossB = await responder(tokenOp, 'publica', 'Tentativa de A em B.', massaB.chamadoBId);
    ok(
      crossB.status === 404 &&
        (await lerChamado(tenantBId, massaB.chamadoBId)).operador_id === null,
      'D-039: token de A não responde (nem assume) o chamado de B (404, B segue sem responsável)',
    );

    // --- 16) Custo do chamado (D-043) ---------------------------------------
    const chCustoId = await runInTenantContext(ds, tenantId, async (em) => {
      const atorAna = { id: massaA.cliAId, tenant_id: tenantId, papel: Papel.cliente };
      const atorOp = { id: massaA.opAId, tenant_id: tenantId, papel: Papel.operador };
      const c = await criarChamado(em, atorAna, {
        titulo: 'Custo pela API (D-043)',
        natureza: Natureza.alteracao,
        descricao: 'Estimativa e custo final.',
      });
      if (!c.ok) throw new Error(`criarChamado (custo) falhou: ${c.motivo}`);
      await transicionarStatus(em, atorSistema(tenantId), c.id, StatusChamado.em_triagem);
      const t = await transicionarStatus(em, atorOp, c.id, StatusChamado.em_atendimento);
      if (!t.ok) throw new Error(`transição (custo) falhou: ${t.motivo}`);
      return c.id;
    });
    const custo = (corpo: unknown, token: string, id = chCustoId, s = slug) =>
      chamar<{ estimativa_custo?: string | null; custo_final?: number | null; codigo?: string }>(
        s,
        `/api/v1/chamados/${id}/custo`,
        { token, metodo: 'POST', corpo },
      );
    const lerCusto = (tid: string, id: string) =>
      runInTenantContext(ds, tid, async (em) => {
        const l: Array<{ estimativa_custo: string | null; custo_final: string | null }> =
          await em.query('SELECT estimativa_custo, custo_final FROM chamado WHERE id = $1', [id]);
        return l[0]!;
      });

    const custoCli = await custo({ estimativa_custo: 'B' }, tokenCli);
    ok(
      custoCli.status === 403 && custoCli.corpo.codigo === 'sem_permissao',
      'D-043: cliente não define custo (403)',
    );
    const custoCliInex = await custo({ estimativa_custo: 'B' }, tokenCli, '999999');
    ok(
      custoCliInex.status === 403,
      'D-043: cliente recebe 403 mesmo para chamado inexistente (não vaza existência)',
    );
    ok(
      (await custo({}, tokenOp)).status === 400 &&
        (await custo({ estimativa_custo: 'b' }, tokenOp)).status === 400 &&
        (await custo({ custo_final: '10,00' }, tokenOp)).status === 400,
      'D-043: corpo vazio, código minúsculo e custo em string → 400',
    );
    const estB = await custo({ estimativa_custo: 'B' }, tokenOp);
    ok(
      estB.status === 200 && estB.corpo.estimativa_custo === 'B' && estB.corpo.custo_final === null,
      'D-043: operador define a estimativa B',
    );
    const estB2 = await custo({ estimativa_custo: 'B' }, tokenOp);
    ok(estB2.status === 200, 'D-043: repetir a mesma estimativa é idempotente (200)');
    const nEst = await runInTenantContext(ds, tenantId, async (em) => {
      const l: Array<{ n: string }> = await em.query(
        `SELECT COUNT(*) AS n FROM evento_chamado WHERE chamado_id = $1 AND tipo = 'estimativa_custo_alterada'`,
        [chCustoId],
      );
      return Number(l[0]!.n);
    });
    ok(nEst === 1, 'D-043: um único evento estimativa_custo_alterada');

    const fora = await custo({ estimativa_custo: 'C', custo_final: 10 }, tokenOp);
    ok(
      fora.status === 409 && fora.corpo.codigo === 'custo_fora_da_resolucao',
      'D-043: custo final fora de resolvido → 409 custo_fora_da_resolucao',
    );
    ok(
      (await lerCusto(tenantId, chCustoId)).estimativa_custo === 'B',
      'D-043: a estimativa enviada junto foi desfeita (transação única)',
    );

    const statusFechado = await chamar<{ codigo?: string }>(
      slug,
      `/api/v1/chamados/${chCustoId}/status`,
      { token: tokenOp, metodo: 'POST', corpo: { status: 'cancelado', custo_final: 5 } },
    );
    ok(statusFechado.status === 400, 'D-043: custo_final em transição ≠ resolvido → 400');
    const resolver = await chamar<{ status?: string; custo_final?: number | null }>(
      slug,
      `/api/v1/chamados/${chCustoId}/status`,
      { token: tokenOp, metodo: 'POST', corpo: { status: 'resolvido', custo_final: 99.9 } },
    );
    ok(
      resolver.status === 200 &&
        resolver.corpo.status === 'resolvido' &&
        resolver.corpo.custo_final === 99.9,
      'D-043: resolver com custo_final = 99.9',
    );
    const detCustoCli = await chamar<{
      chamado: { estimativa_custo: string | null; custo_final: number | null };
    }>(slug, `/api/v1/chamados/${chCustoId}`, { token: tokenCli });
    ok(
      detCustoCli.status === 200 &&
        detCustoCli.corpo.chamado.estimativa_custo === 'B' &&
        detCustoCli.corpo.chamado.custo_final === 99.9 &&
        !('complexidade' in detCustoCli.corpo.chamado),
      'D-043: cliente LÊ estimativa e custo final no detalhe (sem complexidade)',
    );
    const listaCustoCli = await chamar<{
      itens: Array<{ id: string; estimativa_custo: string | null; custo_final: number | null }>;
    }>(slug, '/api/v1/chamados?meus=true&limite=100', { token: tokenCli });
    const itemCusto = listaCustoCli.corpo.itens.find((i) => i.id === chCustoId);
    ok(
      !!itemCusto && itemCusto.estimativa_custo === 'B' && itemCusto.custo_final === 99.9,
      'D-043: item da lista do cliente traz estimativa e custo final',
    );
    const corr = await custo({ custo_final: 120 }, tokenOp);
    ok(corr.status === 200 && corr.corpo.custo_final === 120, 'D-043: operador corrige o custo');
    ok(
      Number((await lerCusto(tenantId, chCustoId)).custo_final) === 120,
      'D-043: custo corrigido gravado (numeric 120.00)',
    );

    // Cross-tenant (regra 6).
    const custoBemA = await custo(
      { estimativa_custo: 'E' },
      loginOpB.corpo.token,
      chCustoId,
      `${slug}-b`,
    );
    ok(custoBemA.status === 404, 'D-043: operador de B não define custo em A (404)');
    ok(
      (await lerCusto(tenantId, chCustoId)).estimativa_custo === 'B',
      'D-043: estimativa de A intacta após a tentativa de B',
    );
    const custoAemB = await custo({ estimativa_custo: 'E' }, tokenOp, massaB.chamadoBId);
    ok(
      custoAemB.status === 404 &&
        (await lerCusto(tenantBId, massaB.chamadoBId)).estimativa_custo === null,
      'D-043: token de A não define custo no chamado de B (404)',
    );

    // --- 17) Upload multipart (D-046, specs/11 §4.3/§4.5) -------------------
    /** POST multipart cru (o `fetch` monta o boundary e o Content-Length). */
    async function enviar<T = Record<string, unknown>>(
      slugAlvo: string,
      caminho: string,
      token: string,
      campos: Record<string, string>,
      arquivos: Array<{ nome: string; bytes: Buffer }>,
    ): Promise<Resposta<T>> {
      const form = new FormData();
      for (const [k, v] of Object.entries(campos)) form.append(k, v);
      for (const a of arquivos)
        form.append('arquivos', new Blob([new Uint8Array(a.bytes)]), a.nome);
      const resp = await fetch(`${BASE}${caminho}`, {
        method: 'POST',
        headers: { 'x-tenant-slug': slugAlvo, authorization: `Bearer ${token}` },
        body: form,
      });
      const texto = await resp.text();
      let corpo: unknown = texto;
      try {
        corpo = JSON.parse(texto);
      } catch {
        /* mantém texto */
      }
      return { status: resp.status, corpo: corpo as T };
    }
    const contarNoChamado = async (
      chamado: string,
    ): Promise<{ mensagens: number; anexos: number }> =>
      runInTenantContext(ds, tenantId, async (em) => {
        const m: Array<{ n: string }> = await em.query(
          'SELECT count(*)::text AS n FROM mensagem WHERE chamado_id = $1',
          [chamado],
        );
        const a: Array<{ n: string }> = await em.query(
          `SELECT count(*)::text AS n FROM anexo
            WHERE chamado_id = $1 OR mensagem_id IN (SELECT id FROM mensagem WHERE chamado_id = $1)`,
          [chamado],
        );
        return { mensagens: Number(m[0]!.n), anexos: Number(a[0]!.n) };
      });
    type AnxUp = { id: string; nome_arquivo: string; content_type: string; inline: boolean };
    const PDF_UP = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const SVG_UP = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const EXE_UP = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1');

    // Cliente abre chamado com print na descrição (imagem → descrição inline).
    const abrir = await enviar<{ id: string; numero: number; anexos: AnxUp[] }>(
      slug,
      '/api/v1/chamados',
      tokenCli,
      { titulo: 'Erro com print (multipart)', descricao: 'A tela mostra isto:' },
      [{ nome: 'erro.png', bytes: PNG }],
    );
    ok(
      abrir.status === 201 &&
        abrir.corpo.anexos.length === 1 &&
        abrir.corpo.anexos[0]!.inline === true &&
        abrir.corpo.anexos[0]!.nome_arquivo === 'erro.png',
      'D-046: cliente abre chamado com print — imagem vira anexo inline da descrição',
    );
    const chUpId = abrir.corpo.id;
    const abrirPdf = await enviar(
      slug,
      '/api/v1/chamados',
      tokenCli,
      { titulo: 'Abertura com PDF', descricao: 'x' },
      [{ nome: 'r.pdf', bytes: PDF_UP }],
    );
    ok(
      abrirPdf.status === 415 && abrirPdf.corpo.codigo === 'tipo_arquivo_nao_permitido',
      'D-046: na abertura só imagens (PDF → 415)',
    );

    // Operador responde com imagem posicionada + PDF.
    const resp1 = await enviar<{ id: string; anexos: AnxUp[] }>(
      slug,
      `/api/v1/chamados/${chUpId}/mensagens`,
      tokenOp,
      {
        visibilidade: 'publica',
        corpo: 'Corrigido. Antes:\n\n![tela corrigida](anexo:depois.png)\n\nRelatório em anexo.',
      },
      [
        { nome: 'depois.png', bytes: PNG },
        { nome: 'relatorio.pdf', bytes: PDF_UP },
      ],
    );
    const inlineUp = resp1.corpo.anexos?.find((a) => a.inline);
    const pdfUp = resp1.corpo.anexos?.find((a) => !a.inline);
    ok(
      resp1.status === 201 &&
        resp1.corpo.anexos.length === 2 &&
        inlineUp?.content_type === 'image/png' &&
        pdfUp?.content_type === 'application/pdf' &&
        pdfUp.nome_arquivo === 'relatorio.pdf',
      'D-046: operador responde com 1 imagem (inline) + 1 PDF (anexo) — 201 com os anexos',
    );
    const detUp = await chamar<Det>(slug, `/api/v1/chamados/${chUpId}?formato=markdown`, {
      token: tokenCli,
    });
    const msgUp = detUp.corpo.mensagens.find((m) => m.anexos.some((a) => a.id === inlineUp?.id));
    ok(
      !!msgUp && msgUp.corpo.includes(`![tela corrigida](/api/v1/anexos/${inlineUp!.id})`),
      'D-046: a imagem APARECE na conversa (markdown com a rota Bearer), no lugar do marcador',
    );
    const bytesUp = await fetch(`${BASE}/api/v1/anexos/${pdfUp!.id}`, {
      headers: { 'x-tenant-slug': slug, authorization: `Bearer ${tokenCli}` },
    });
    ok(
      bytesUp.status === 200 &&
        Buffer.from(await bytesUp.arrayBuffer()).equals(PDF_UP) &&
        (bytesUp.headers.get('content-disposition') ?? '').startsWith('attachment'),
      'D-046: o cliente baixa o PDF publicado (attachment, bytes íntegros)',
    );

    // Tipo proibido: nada é publicado.
    const antesProibido = await contarNoChamado(chUpId);
    for (const [nome, bytes] of [
      ['logo.svg', SVG_UP],
      ['setup.exe', EXE_UP],
    ] as const) {
      const r = await enviar(
        slug,
        `/api/v1/chamados/${chUpId}/mensagens`,
        tokenOp,
        { visibilidade: 'interna', corpo: 'tentativa' },
        [
          { nome: 'ok.png', bytes: PNG },
          { nome, bytes },
        ],
      );
      ok(
        r.status === 415 && r.corpo.codigo === 'tipo_arquivo_nao_permitido',
        `D-046: ${nome} → 415 tipo_arquivo_nao_permitido`,
      );
    }
    const grande = await enviar(
      slug,
      `/api/v1/chamados/${chUpId}/mensagens`,
      tokenOp,
      { visibilidade: 'interna', corpo: 'grande' },
      [{ nome: 'grande.png', bytes: Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)]) }],
    );
    ok(
      grande.status === 413 && grande.corpo.codigo === 'arquivo_muito_grande',
      'D-046: arquivo acima de 25 MB → 413 arquivo_muito_grande',
    );
    const depoisProibido = await contarNoChamado(chUpId);
    ok(
      depoisProibido.mensagens === antesProibido.mensagens &&
        depoisProibido.anexos === antesProibido.anexos,
      'D-046: recusas não publicam NADA (nem mensagem nem anexo)',
    );

    // Cliente dono anexa no próprio chamado; não-dono é recusado.
    const doDono = await enviar<{ anexos: AnxUp[] }>(
      slug,
      `/api/v1/chamados/${chUpId}/mensagens`,
      tokenCli,
      { visibilidade: 'publica' },
      [{ nome: 'mais-um-print.png', bytes: PNG }],
    );
    ok(
      doDono.status === 201 && doDono.corpo.anexos[0]?.inline === true,
      'D-046: cliente dono anexa print no próprio chamado (corpo vazio + imagem)',
    );
    const antesAlheio = await contarNoChamado(chamadoAlheioId);
    const alheioUp = await enviar(
      slug,
      `/api/v1/chamados/${chamadoAlheioId}/mensagens`,
      tokenCli,
      { visibilidade: 'publica', corpo: 'anexo intruso' },
      [{ nome: 'intruso.png', bytes: PNG }],
    );
    const depoisAlheio = await contarNoChamado(chamadoAlheioId);
    ok(
      alheioUp.status === 403 &&
        alheioUp.corpo.codigo === 'sem_permissao' &&
        depoisAlheio.anexos === antesAlheio.anexos &&
        depoisAlheio.mensagens === antesAlheio.mensagens,
      'D-046: cliente NÃO-dono → 403 ao anexar em chamado alheio (lê, mas não anexa — D-037)',
    );

    // Cross-tenant (regra 6).
    const tokenOpB = loginOpB.corpo.token;
    const baixarDeB = await fetch(`${BASE}/api/v1/anexos/${inlineUp!.id}`, {
      headers: { 'x-tenant-slug': `${slug}-b`, authorization: `Bearer ${tokenOpB}` },
    });
    ok(baixarDeB.status === 404, 'D-046: token do tenant B não baixa o anexo enviado em A (404)');
    const tokenAemB = await fetch(`${BASE}/api/v1/anexos/${inlineUp!.id}`, {
      headers: { 'x-tenant-slug': `${slug}-b`, authorization: `Bearer ${tokenOp}` },
    });
    ok(tokenAemB.status === 401, 'D-046: token de A apresentado no host de B não autentica (401)');
    const antesB = await contarNoChamado(chUpId);
    const publicarDeB = await enviar(
      `${slug}-b`,
      `/api/v1/chamados/${chUpId}/mensagens`,
      tokenOpB,
      { visibilidade: 'interna', corpo: 'de B' },
      [{ nome: 'b.png', bytes: PNG }],
    );
    ok(
      publicarDeB.status === 404 && (await contarNoChamado(chUpId)).anexos === antesB.anexos,
      'D-046: operador de B não anexa no chamado de A (404, nada gravado)',
    );

    // Cliente tipado (MCP/Forja) contra a API real.
    const clienteUp = new ClienteChamados({
      baseUrl: BASE,
      email: operadorEmail,
      obterSenha: () => SENHA,
      tenantSlug: slug,
    });
    const viaCliente = await clienteUp.publicarMensagemComArquivos(chUpId, {
      visibilidade: 'interna',
      corpo: 'Evidências da Forja.',
      arquivos: [
        { nome: 'antes.png', conteudo: PNG },
        { nome: 'depois.png', conteudo: PNG },
      ],
    });
    ok(
      (viaCliente.anexos ?? []).filter((a) => a.inline).length === 2,
      'D-046: ClienteChamados.publicarMensagemComArquivos publica nota interna com 2 prints',
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
