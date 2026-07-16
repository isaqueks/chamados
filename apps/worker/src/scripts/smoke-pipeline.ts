/**
 * Smoke do PIPELINE DE TRIAGEM (M7 — specs/05 §3-§8). IA_PROVIDER=fake, fila
 * processada INLINE (chama o processador direto), tenants DESCARTÁVEIS (NÃO toca
 * o acme — outro agente usa o banco em paralelo). Prova ponta a ponta:
 *
 *   Transição na criação: criar com despachante → novo→em_triagem (ator sistema).
 *   1) não entendeu  → pergunta PÚBLICA numerada + aguardando_cliente + ia_pediu_info.
 *   2) entendeu fácil → nota INTERNA de diagnóstico + complexidade/prioridade
 *                       APLICADAS + em_atendimento + ia_diagnosticou.
 *   3) operador tocou antes → prioridade NÃO sobrescrita (vira sugestão).
 *   4) alteracao     → nota interna com SPEC COMPLETA + ia_gerou_spec.
 *   5) falha         → ExecucaoIA falhou + ia_falhou + em_atendimento (escalonado).
 *   6) FERRAMENTAS reais (fixtures locais): repo_buscar/ler funcionam e bloqueiam
 *      path traversal; bd_consultar aceita SELECT e REJEITA INSERT/DDL; logs lê
 *      com limite. Cliente NUNCA vê as notas internas da IA.
 *
 * Requer Postgres + Redis de pé (compose). Sai 0 se passa; 1 caso contrário.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import pg from 'pg';
import simpleGit from 'simple-git';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();
process.env.IA_PROVIDER = 'fake';
process.env.TRIAGEM_DEBOUNCE_S = '0';
// D-011: o fixture aponta o SistemaAlvo para um repo em CAMINHO LOCAL direto — a
// criação exige a flag ligada (default é OFF na oferta SaaS).
process.env.SISTEMAS_PERMITIR_REPO_LOCAL = 'true';
// Chave mestra do cofre (para guardar/decifrar a credencial de BD do fixture).
if (!process.env.SECRET_STORE_MASTER_KEY || process.env.SECRET_STORE_MASTER_KEY.trim() === '') {
  process.env.SECRET_STORE_MASTER_KEY = randomBytes(32).toString('base64');
}
// Cache de working copies isolado (setado ANTES de importar os módulos de ferramentas).
const CACHE_DIR = join(tmpdir(), `chamados-smoke-cache-${randomBytes(4).toString('hex')}`);
process.env.IA_REPO_CACHE_DIR = CACHE_DIR;

const {
  criarAppDataSource,
  criarAdminDataSource,
  runInTenantContext,
  provisionarTenant,
  criarUsuarioAtivoComSenha,
  criarSistemaAlvo,
  criarSecretStore,
  criarChamado,
  criarMensagem,
  atribuirOperador,
  listarMensagens,
  listarEventos,
  conexaoBase,
  credenciaisAdmin,
  ChamadoSchema,
  DespachanteNotificacoes,
} = await import('@chamados/db');
const {
  Papel,
  StatusTenant,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  VisibilidadeMensagem,
} = await import('@chamados/shared');
const { processarTriagem } = await import('../triagem/processador');
const { montarInput } = await import('../triagem/contexto');
const { resolverProvider } = await import('../ia/resolver-provider');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const log = (): void => {};

/** Visibilidade de um item da timeline (a projeção do cliente não a expõe). */
const vis = (m: unknown): string | undefined => (m as { visibilidade?: string }).visibilidade;
const corpo = (m: unknown): string => (m as { corpo_html?: string }).corpo_html ?? '';

const LIMITES = { timeoutMs: 30_000, budgetUsd: 1, maxTurnos: 5 };
const LOCK = { ttlMs: 60_000, esperaMaxMs: 5_000, intervaloMs: 100 };

// ---------------------------------------------------------------------------
// Fixture: repositório git temporário
// ---------------------------------------------------------------------------
async function criarRepoFixture(): Promise<string> {
  const dir = join(tmpdir(), `chamados-smoke-repo-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    join(dir, 'app.js'),
    "function salvarPedido() {\n  throw new Error('erro 500 ao salvar pedido');\n}\n",
  );
  await fs.writeFile(join(dir, 'src', 'util.js'), "export const versao = '1.0.0';\n");
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.email', 'fixture@smoke.dev');
  await g.addConfig('user.name', 'Fixture Smoke');
  await g.add('.');
  await g.commit('commit inicial do fixture');
  return dir;
}

// ---------------------------------------------------------------------------
// Fixture: arquivo de log temporário
// ---------------------------------------------------------------------------
async function criarLogFixture(): Promise<string> {
  const arq = join(tmpdir(), `chamados-smoke-log-${randomBytes(4).toString('hex')}.log`);
  const linhas: string[] = [];
  for (let i = 0; i < 300; i++) {
    const nivel = i % 50 === 0 ? 'ERROR' : 'INFO';
    linhas.push(`2026-07-15T10:00:${String(i % 60).padStart(2, '0')} ${nivel} linha ${i}`);
  }
  await fs.writeFile(arq, linhas.join('\n') + '\n');
  return arq;
}

// ---------------------------------------------------------------------------
// Fixture: database scratch com usuário READ-ONLY no próprio Postgres do compose
// ---------------------------------------------------------------------------
interface ScratchBd {
  nome: string;
  usuario: string;
  senha: string;
  encerrar: () => Promise<void>;
}

async function criarScratchBd(admin: import('typeorm').DataSource): Promise<ScratchBd> {
  const suf = randomBytes(4).toString('hex');
  const nome = `smoke_pipe_db_${suf}`;
  const usuario = `smoke_pipe_ro_${suf}`;
  const senha = `p_${randomBytes(6).toString('hex')}`;

  await admin.query(`CREATE ROLE "${usuario}" LOGIN PASSWORD '${senha}'`);
  await admin.query(`CREATE DATABASE "${nome}"`);

  // Popular a base + conceder SELECT ao usuário read-only (conexão dedicada).
  const client = new pg.Client({
    host: conexaoBase.host,
    port: conexaoBase.port,
    database: nome,
    user: credenciaisAdmin.username,
    password: credenciaisAdmin.password,
  });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE clientes (id int PRIMARY KEY, nome text NOT NULL, ativo boolean NOT NULL DEFAULT true)`,
    );
    await client.query(
      `INSERT INTO clientes (id, nome) VALUES (1,'Alice'),(2,'Bruno'),(3,'Carla')`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO "${usuario}"`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${usuario}"`);
  } finally {
    await client.end();
  }

  const encerrar = async (): Promise<void> => {
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS "${usuario}"`).catch(() => {});
  };
  return { nome, usuario, senha, encerrar };
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  const admin = criarAdminDataSource();
  await admin.initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
    maxRetriesPerRequest: null,
  });
  console.log('[smoke-pipeline] conectado (role da app, sem bypass) + Redis + admin.');

  const provider = resolverProvider({ provider: 'fake', modelo: 'ignorado' });
  const deps = { ds, redis, provider, limites: LIMITES, lock: LOCK, log };

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let categoriaGeral = '';
  let repoDir = '';
  let logFile = '';
  let scratch: ScratchBd | null = null;

  /** Cria um chamado (categoria geral) e retorna seu id. Sem despachante → novo. */
  async function abrir(
    atorCli: { id: string; tenant_id: string; papel: (typeof Papel)['cliente'] },
    titulo: string,
    natureza: (typeof Natureza)[keyof typeof Natureza] = Natureza.problema,
  ): Promise<string> {
    return runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo,
        descricao: 'Descrição do chamado de teste.',
        natureza,
        categoria_id: categoriaGeral,
      });
      if (!r.ok) throw new Error(`falha ao criar chamado: ${r.motivo}`);
      return r.id;
    });
  }

  /** Processa a triagem inline (gatilho chamado_criado, mensagem inicial). */
  async function triar(chamadoId: string): Promise<{ status: string }> {
    return processarTriagem(
      { tenantId: tenantA, chamadoId, ultimaMensagemId: null, gatilho: 'chamado_criado' },
      deps,
    );
  }

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-pipe-a-${sufixo}`,
      nome: 'Pipe A',
      nomeExibicao: 'Pipe A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    categoriaGeral = provA.categoria_geral_id;

    const { cliente, operador } = await runInTenantContext(ds, tenantA, async (em) => {
      const cliente = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Cliente A',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const operador = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Operador A',
        papel: Papel.operador,
        senha: 'Dev@12345',
      });
      return { cliente, operador };
    });
    const atorCli = { id: cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorOp = { id: operador, tenant_id: tenantA, papel: Papel.operador };

    // ---- Transição na criação (com despachante) --------------------------
    console.log('\n[transição na criação]');
    const chCriacao = await runInTenantContext(ds, tenantA, async (em) => {
      const eventos: Array<{ tipo: string }> = [];
      const r = await criarChamado(
        em,
        atorCli,
        { titulo: 'Chamado com triagem na criação', descricao: 'x', natureza: Natureza.problema },
        { despachante: { publicar: (e) => eventos.push(e) } },
      );
      if (!r.ok) throw new Error('falha ao criar (criação)');
      const ch = await em.findOne(ChamadoSchema, { where: { id: r.id } });
      ok(ch?.status === StatusChamado.em_triagem, 'criação com despachante → novo→em_triagem');
      ok(
        eventos.some((e) => e.tipo === 'triagem_solicitada'),
        'criação publica evento de domínio triagem_solicitada',
      );
      return r.id;
    });
    void chCriacao;

    // ---- 1) Não entendeu -------------------------------------------------
    console.log('\n[1] não entendeu');
    const ch1 = await abrir(atorCli, 'Algo estranho acontece [[nao-entendeu]]');
    ok((await triar(ch1)).status === 'concluido', 'triagem processou (não entendeu) → concluido');
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: ch1 } });
      ok(ch?.status === StatusChamado.aguardando_cliente, 'status → aguardando_cliente');
      const msgs = await listarMensagens(em, atorOp, ch1);
      const publica = msgs.find((m) => vis(m) === 'publica' && m.autor_id !== cliente);
      ok(!!publica, 'existe mensagem PÚBLICA da IA');
      ok(/1\./.test(corpo(publica)), 'perguntas ao cliente são NUMERADAS');
      const evs = await listarEventos(em, atorOp, ch1);
      ok(
        evs.some((e) => e.tipo === 'ia_pediu_info'),
        'evento ia_pediu_info registrado',
      );
      // Cliente VÊ a pergunta pública.
      const comoCliente = await listarMensagens(em, atorCli, ch1);
      ok(
        comoCliente.some((m) => /1\./.test(corpo(m))),
        'cliente vê a pergunta pública',
      );
    });

    // ---- 2) Entendeu problema fácil (prioridade APLICADA) ----------------
    console.log('\n[2] entendeu fácil (prioridade aplicada)');
    const ch2 = await abrir(
      atorCli,
      'Erro 500 ao salvar [[complexidade:facil]][[prioridade:alta]]',
    );
    ok((await triar(ch2)).status === 'concluido', 'triagem processou (entendeu) → concluido');
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: ch2 } });
      ok(ch?.status === StatusChamado.em_atendimento, 'status → em_atendimento');
      ok(ch?.complexidade === Complexidade.facil, 'complexidade aplicada (facil)');
      ok(
        ch?.prioridade === Prioridade.alta,
        'prioridade sugerida APLICADA (alta) — chamado virgem',
      );
      const msgs = await listarMensagens(em, atorOp, ch2);
      ok(
        msgs.some((m) => vis(m) === 'interna' && /Diagn[óo]stico/i.test(corpo(m))),
        'nota INTERNA de diagnóstico publicada',
      );
      const evs = await listarEventos(em, atorOp, ch2);
      ok(
        evs.some((e) => e.tipo === 'ia_diagnosticou'),
        'evento ia_diagnosticou registrado',
      );
      // Cliente NÃO vê a nota interna nem a complexidade.
      const comoCliente = await listarMensagens(em, atorCli, ch2);
      ok(
        comoCliente.every((m) => vis(m) === undefined || vis(m) === 'publica'),
        'cliente NÃO vê a nota interna da IA',
      );
    });

    // ---- 3) Operador tocou antes → prioridade NÃO sobrescrita -------------
    console.log('\n[3] operador tocou antes (prioridade só sugerida)');
    const ch3 = await abrir(
      atorCli,
      'Lentidão no relatório [[complexidade:medio]][[prioridade:urgente]]',
    );
    await runInTenantContext(ds, tenantA, (em) => atribuirOperador(em, atorOp, ch3, operador));
    ok((await triar(ch3)).status === 'concluido', 'triagem processou (operador tocou) → concluido');
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: ch3 } });
      ok(
        ch?.prioridade === Prioridade.media,
        'prioridade NÃO sobrescrita (permanece a default media)',
      );
      const evs = await listarEventos(em, atorOp, ch3);
      ok(!evs.some((e) => e.tipo === 'prioridade_alterada'), 'nenhum evento prioridade_alterada');
      const msgs = await listarMensagens(em, atorOp, ch3);
      ok(
        msgs.some((m) => vis(m) === 'interna' && /Prioridade sugerida/i.test(corpo(m))),
        'nota interna registra a prioridade apenas como SUGESTÃO',
      );
    });

    // ---- 4) Alteração → SPEC completa ------------------------------------
    console.log('\n[4] alteração → SPEC');
    const ch4 = await abrir(
      atorCli,
      'Adicionar filtro por data [[natureza:alteracao]][[complexidade:medio]]',
    );
    ok((await triar(ch4)).status === 'concluido', 'triagem processou (alteracao) → concluido');
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: ch4 } });
      ok(ch?.natureza === Natureza.alteracao, 'natureza reclassificada para alteracao');
      const msgs = await listarMensagens(em, atorOp, ch4);
      const spec = msgs.find((m) => vis(m) === 'interna' && /# SPEC/.test(corpo(m)));
      ok(!!spec, 'nota interna com SPEC publicada');
      ok(
        /Crit[ée]rios de aceite/i.test(corpo(spec)) && /Estimativa/i.test(corpo(spec)),
        'SPEC segue o TEMPLATE completo (seções obrigatórias)',
      );
      const evs = await listarEventos(em, atorOp, ch4);
      ok(
        evs.some((e) => e.tipo === 'ia_gerou_spec'),
        'evento ia_gerou_spec registrado',
      );
    });

    // ---- 5) Falha → escalonamento ----------------------------------------
    console.log('\n[5] falha → escalonamento');
    const ch5 = await abrir(atorCli, 'Chamado que força falha [[falhar]]');
    ok((await triar(ch5)).status === 'falhou', 'triagem falhou (provider [[falhar]])');
    await runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: ch5 } });
      ok(
        ch?.status === StatusChamado.em_atendimento,
        'falha → em_atendimento (nunca preso em em_triagem)',
      );
      ok(ch?.complexidade === null, 'falha NÃO classifica (sem complexidade)');
      const evs = await listarEventos(em, atorOp, ch5);
      ok(
        evs.some((e) => e.tipo === 'ia_falhou'),
        'evento ia_falhou registrado',
      );
      const rows: Array<{ status: string; erro: string | null }> = await em.query(
        `SELECT status, erro FROM execucao_ia WHERE chamado_id = $1`,
        [ch5],
      );
      ok(rows[0]?.status === 'falhou', 'ExecucaoIA.status = falhou');
    });

    // ---- D-015) resposta pública + separação técnica + continuidade ------
    console.log('\n[D-015a] resposta pública LIMPA + nota interna do operador (continuidade)');
    const chResp = await abrir(
      atorCli,
      'Não consigo gerar o relatório mensal [[responder-cliente]]',
    );
    const NOTA_OP = 'Interno: priorize a hipótese de timeout no banco de dados.';
    await runInTenantContext(ds, tenantA, (em) =>
      criarMensagem(em, atorOp, {
        chamado_id: chResp,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: NOTA_OP,
      }),
    );
    ok((await triar(chResp)).status === 'concluido', 'triagem (responder-cliente) → concluido');
    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chResp);
      const pub = msgs.find((m) => vis(m) === 'publica' && m.autor_id !== cliente);
      ok(!!pub, 'resposta PÚBLICA do agente_ia publicada');
      ok(/Entendi seu pedido/i.test(corpo(pub)), 'resposta pública é a mensagem amigável (limpa)');
      const diag = msgs.find((m) => vis(m) === 'interna' && /Diagn[óo]stico/i.test(corpo(m)));
      ok(!!diag, 'nota INTERNA de diagnóstico publicada');
      // A nota interna do operador chegou ao INPUT do provider (o fake a ecoa → continuidade).
      ok(
        /timeout no banco de dados/i.test(corpo(diag)),
        'nota interna do operador apareceu no INPUT do provider (ecoada → continuidade)',
      );
      // Ordem: a resposta pública vem ANTES da nota interna na timeline (D-015).
      const iPub = msgs.findIndex((m) => m.id === pub!.id);
      const iDiag = msgs.findIndex((m) => m.id === diag!.id);
      ok(iPub < iDiag, 'resposta pública vem ANTES da nota interna na timeline');
      // Evento de mensagem pública gerado (dispara notificação ao cliente).
      const evs = await listarEventos(em, atorOp, chResp);
      ok(
        evs.some((e) => e.tipo === 'mensagem_publicada'),
        'evento mensagem_publicada gerado',
      );
      // Cliente VÊ a resposta pública e NÃO vê a orientação interna nem o diagnóstico.
      const comoCliente = await listarMensagens(em, atorCli, chResp);
      ok(
        comoCliente.some((m) => /Entendi seu pedido/i.test(corpo(m))),
        'cliente VÊ a resposta pública',
      );
      ok(
        comoCliente.every((m) => !/timeout no banco/i.test(corpo(m))),
        'cliente NÃO vê a orientação interna do operador',
      );
    });

    console.log('\n[D-015b] resposta pública TÉCNICA é rebaixada (técnico só na nota interna)');
    const chTec = await abrir(atorCli, 'Erro ao salvar pedido [[responder-cliente-tecnico]]');
    ok(
      (await triar(chTec)).status === 'concluido',
      'triagem (responder-cliente-tecnico) → concluido',
    );
    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chTec);
      const pub = msgs.find((m) => vis(m) === 'publica' && m.autor_id !== cliente);
      ok(!!pub, 'resposta pública publicada (rebaixada)');
      ok(
        /nossa equipe/i.test(corpo(pub)) && !/salvarPedido|src\//.test(corpo(pub)),
        'resposta pública REBAIXADA para genérica (sem termo técnico)',
      );
      const nota = msgs.find(
        (m) => vis(m) === 'interna' && /rebaixada pelo validador/i.test(corpo(m)),
      );
      ok(!!nota, 'nota interna registra o rebaixamento pelo validador');
      ok(
        /src\/pedidos\/salvar\.js/.test(corpo(nota)),
        'texto técnico ORIGINAL preservado apenas na nota interna',
      );
      // Cliente NÃO recebe nenhum detalhe técnico.
      const comoCliente = await listarMensagens(em, atorCli, chTec);
      ok(
        comoCliente.every((m) => !/salvarPedido|src\/|\.js/.test(corpo(m))),
        'cliente NÃO recebe nenhum detalhe técnico (só a genérica)',
      );
    });

    // ---- 6) Ferramentas reais (fixtures locais) --------------------------
    console.log('\n[6] ferramentas reais');
    repoDir = await criarRepoFixture();
    logFile = await criarLogFixture();
    scratch = await criarScratchBd(admin);
    const sc = scratch;

    const sistemaAlvoId = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, criarSecretStore(), tenantA, {
        nome: 'Sistema Fixture',
        git_repo_url: repoDir,
        logs_tipo: 'arquivo',
        logs_config: { caminho: logFile },
        bd_tipo: 'postgres',
        bd_host: conexaoBase.host,
        bd_porta: conexaoBase.port,
        bd_nome: sc.nome,
        bd_credencial: `${sc.usuario}:${sc.senha}`,
      }),
    );

    const chTool = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo: 'Chamado com sistema-alvo',
        descricao: 'x',
        natureza: Natureza.problema,
        sistema_alvo_id: sistemaAlvoId,
      });
      if (!r.ok) throw new Error(`falha ao criar chamado tool: ${r.motivo}`);
      return r.id;
    });

    const prep = await runInTenantContext(ds, tenantA, (em) =>
      montarInput(em, chTool, { acoes: [], log, limites: LIMITES }),
    );
    if (!prep) throw new Error('montarInput devolveu null');
    // D-011: o git_repo_url é um CAMINHO LOCAL DIRETO (não http, não file://). O
    // worker clona nativamente, sem injetar credencial.
    ok(
      !/^https?:\/\//i.test(repoDir) && !/^file:\/\//i.test(repoDir),
      'fixture usa caminho local DIRETO como git_repo_url (D-011)',
    );
    await prep.sincronizar(); // git clone do fixture a partir do caminho local direto
    const f = prep.input.ferramentas;
    try {
      // repo_buscar / repo_ler_arquivo — provam que o clone do caminho local funcionou.
      const busca = await f.repo_buscar('erro 500');
      ok(
        busca.some((r) => r.caminho === 'app.js'),
        'repo_buscar encontra "erro 500" em app.js (clone do caminho local direto)',
      );
      const conteudo = await f.repo_ler_arquivo('app.js');
      ok(conteudo.includes('salvarPedido'), 'repo_ler_arquivo lê o arquivo do checkout');

      // Path traversal bloqueado (relativo e absoluto).
      let bloqueou = false;
      await f.repo_ler_arquivo('../../../../etc/passwd').catch(() => (bloqueou = true));
      ok(bloqueou, 'repo_ler_arquivo BLOQUEIA path traversal (..)');
      bloqueou = false;
      await f.repo_ler_arquivo('/etc/passwd').catch(() => (bloqueou = true));
      ok(bloqueou, 'repo_ler_arquivo BLOQUEIA caminho absoluto');

      // logs_consultar com limite.
      const logs = await f.logs_consultar({ limite: 5 });
      ok(logs.length === 5, 'logs_consultar respeita o limite (5 linhas)');
      const errosLog = await f.logs_consultar({ consulta: 'ERROR', limite: 50 });
      ok(
        errosLog.length > 0 && errosLog.every((l) => /ERROR/.test(l.mensagem)),
        'logs_consultar filtra por consulta (ERROR)',
      );

      // bd_consultar: SELECT aceito, INSERT/DDL rejeitados ANTES de executar.
      const linhas = await f.bd_consultar('SELECT id, nome FROM clientes ORDER BY id');
      ok(linhas.length === 3, 'bd_consultar SELECT devolve as 3 linhas');
      let rejeitou = false;
      await f
        .bd_consultar("INSERT INTO clientes (id, nome) VALUES (9, 'X')")
        .catch(() => (rejeitou = true));
      ok(rejeitou, 'bd_consultar REJEITA INSERT (antes de executar)');
      rejeitou = false;
      await f.bd_consultar('DROP TABLE clientes').catch(() => (rejeitou = true));
      ok(rejeitou, 'bd_consultar REJEITA DDL (DROP)');
      rejeitou = false;
      await f.bd_consultar('SELECT 1; DROP TABLE clientes').catch(() => (rejeitou = true));
      ok(rejeitou, 'bd_consultar REJEITA múltiplas instruções (statement stacking)');
      // Prova de leitura pós-tentativas: a tabela permanece intacta.
      const ainda = await f.bd_consultar('SELECT count(*)::int AS n FROM clientes');
      ok((ainda[0] as { n: number }).n === 3, 'tabela intacta após tentativas de escrita');
    } finally {
      await prep.encerrar();
    }

    console.log('\n[smoke-pipeline] RESULTADO: PASSOU — pipeline de triagem confirmado.');
  } finally {
    // O processador agora enfileira notificações (M9) pós-commit; fecha a conexão
    // do publicador da fila `notificacoes` para o processo do smoke não travar.
    await DespachanteNotificacoes.fechar().catch(() => {});
    redis.disconnect();
    // Limpeza de fixtures de filesystem.
    for (const d of [repoDir, logFile, CACHE_DIR].filter(Boolean)) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    // Limpeza do scratch BD.
    if (scratch) await scratch.encerrar().catch(() => {});
    // Limpeza dos tenants descartáveis (ordem FK-safe).
    try {
      for (const id of [tenantA].filter(Boolean)) {
        for (const tbl of [
          'anexo',
          'mensagem',
          'evento_chamado',
          'execucao_ia',
          'chamado',
          'sistema_alvo',
          'segredo',
          'categoria',
          'tenant_contador',
          'usuario',
        ]) {
          await admin.query(`DELETE FROM "${tbl}" WHERE tenant_id = $1`, [id]).catch(() => {});
        }
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]).catch(() => {});
      }
    } catch (e) {
      console.warn('[smoke-pipeline] aviso: limpeza parcial:', e);
    }
    await admin.destroy();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-pipeline] RESULTADO: FALHOU —', err?.message ?? err);
  process.exit(1);
});
