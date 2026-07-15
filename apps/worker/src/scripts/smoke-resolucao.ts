/**
 * Smoke da RESOLUÇÃO AUTOMÁTICA VIA PR (M8 — specs/05 §6, specs/09 §4).
 * IA_PROVIDER=fake, fila processada INLINE, tenants DESCARTÁVEIS (NÃO toca o acme).
 * Fixtures 100% LOCAIS (repo bare local como origin + cache; SEM GitHub real).
 *
 * Prova:
 *   GATE (o gate vive no PIPELINE, nunca no provider):
 *     a) tenant desabilitado → NÃO tenta (sem PR, sem branch, sem evento);
 *     b) complexidade media  → NÃO tenta (gate PÓS-call);
 *     c) natureza alteracao  → NÃO tenta (gate PRÉ-call);
 *   FLUXO COMPLETO ([[resolver]], problema+facil, tenant habilitado):
 *     - branch `ia/chamado-<numero>-<slug>` criada no BARE com o commit esperado;
 *     - working copy DESCARTÁVEL destruída; cache INTACTO e LIMPO (sem credencial);
 *     - nota INTERNA com resumo/branch + evento `ia_abriu_pr` + ExecucaoIA c/ tentativa;
 *     - cliente NÃO vê a nota nem o evento; dashboard lista o PR pendente;
 *   FALHA de push (origin somente-leitura via pre-receive) → nota de FALHA +
 *     `ia_falhou` + chamado consistente (diagnóstico intacto, em_atendimento).
 *
 * O client da API do GitHub tem teste unitário separado (github-pr.test.ts).
 * Requer Postgres + Redis de pé (compose). Sai 0 se passa; 1 caso contrário.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import simpleGit from 'simple-git';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();
process.env.IA_PROVIDER = 'fake';
process.env.TRIAGEM_DEBOUNCE_S = '0';
if (!process.env.SECRET_STORE_MASTER_KEY || process.env.SECRET_STORE_MASTER_KEY.trim() === '') {
  process.env.SECRET_STORE_MASTER_KEY = randomBytes(32).toString('base64');
}
// Cache de working copies isolado (ANTES de importar os módulos de ferramentas).
const CACHE_DIR = join(tmpdir(), `chamados-smoke-res-cache-${randomBytes(4).toString('hex')}`);
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
  atualizarConfigGeral,
  listarMensagens,
  listarEventos,
  prsIaAguardandoRevisao,
  ChamadoSchema,
  DespachanteNotificacoes,
} = await import('@chamados/db');
const { Papel, StatusTenant, StatusChamado, Natureza, Complexidade, nomeBranchResolucao } =
  await import('@chamados/shared');
const { processarTriagem } = await import('../triagem/processador');
const { resolverProvider } = await import('../ia/resolver-provider');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const log = (): void => {};
const vis = (m: unknown): string | undefined => (m as { visibilidade?: string }).visibilidade;
const corpo = (m: unknown): string => (m as { corpo_html?: string }).corpo_html ?? '';

const LIMITES = { timeoutMs: 30_000, budgetUsd: 1, maxTurnos: 5 };
const LOCK = { ttlMs: 60_000, esperaMaxMs: 5_000, intervaloMs: 100 };

// ---------------------------------------------------------------------------
// Fixtures git locais: repo fonte → bare (origin). Sem rede, sem GitHub.
// ---------------------------------------------------------------------------
async function criarRepoFonte(): Promise<string> {
  const dir = join(tmpdir(), `chamados-res-fonte-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'app.js'), "function salvarPedido() {\n  return 'ok';\n}\n");
  await fs.writeFile(join(dir, 'README.md'), '# Sistema fixture\n');
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.email', 'fixture@smoke.dev');
  await g.addConfig('user.name', 'Fixture Smoke');
  await g.add('.');
  await g.commit('commit inicial do fixture');
  await g.branch(['-M', 'main']); // garante default 'main'
  return dir;
}

/** Cria um bare (origin) clonando o fonte. `rejeitar` → pre-receive que nega push. */
async function criarBare(fonte: string, rejeitar = false): Promise<string> {
  const bare = join(tmpdir(), `chamados-res-bare-${randomBytes(4).toString('hex')}.git`);
  await simpleGit().clone(fonte, bare, ['--bare']);
  if (rejeitar) {
    const hook = join(bare, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\necho "origin somente-leitura" 1>&2\nexit 1\n');
    await fs.chmod(hook, 0o755).catch(() => {});
  }
  return bare;
}

/** Lista os nomes de branch locais de um bare. */
async function branchesBare(bare: string): Promise<string[]> {
  const r = await simpleGit(bare).branch();
  return r.all;
}

/** Conta diretórios de working copy descartável remanescentes no tmp. */
async function contarDescartaveis(): Promise<number> {
  const entradas = await fs.readdir(tmpdir()).catch(() => [] as string[]);
  return entradas.filter((e) => e.startsWith('chamados-resolucao-')).length;
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
  console.log('[smoke-resolucao] conectado (role da app, sem bypass) + Redis + admin.');

  const provider = resolverProvider({ provider: 'fake', modelo: 'ignorado' });
  const deps = { ds, redis, provider, limites: LIMITES, lock: LOCK, log, resolucao: {} };

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let categoriaGeral = '';
  const fixturesFs: string[] = [];
  let sistemaOk = '';
  let sistemaRO = '';
  let bareOk = '';
  let bareRO = '';

  const setFlag = (habilitada: boolean): Promise<void> =>
    runInTenantContext(ds, tenantA, (em) =>
      atualizarConfigGeral(em, tenantA, {
        dias_fechamento_automatico: 3,
        ia_resolucao_automatica_habilitada: habilitada,
      }),
    );

  async function abrir(
    atorCli: { id: string; tenant_id: string; papel: (typeof Papel)['cliente'] },
    titulo: string,
    sistemaAlvoId: string,
    natureza: (typeof Natureza)[keyof typeof Natureza] = Natureza.problema,
  ): Promise<string> {
    return runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarChamado(em, atorCli, {
        titulo,
        descricao: 'Descrição do chamado de teste.',
        natureza,
        sistema_alvo_id: sistemaAlvoId,
      });
      if (!r.ok) throw new Error(`falha ao criar chamado: ${r.motivo}`);
      return r.id;
    });
  }

  const triar = (chamadoId: string): Promise<{ status: string }> =>
    processarTriagem(
      { tenantId: tenantA, chamadoId, ultimaMensagemId: null, gatilho: 'chamado_criado' },
      deps,
    );

  const infoChamado = (
    chamadoId: string,
  ): Promise<{ numero: string; titulo: string; status: string; complexidade: string | null }> =>
    runInTenantContext(ds, tenantA, async (em) => {
      const ch = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
      return {
        numero: String(ch!.numero),
        titulo: ch!.titulo,
        status: ch!.status,
        complexidade: ch!.complexidade,
      };
    });

  const baselineDescartaveis = await contarDescartaveis();

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-res-a-${sufixo}`,
      nome: 'Res A',
      nomeExibicao: 'Res A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    categoriaGeral = provA.categoria_geral_id;
    void categoriaGeral;

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

    // Fixtures git locais.
    const fonte = await criarRepoFonte();
    fixturesFs.push(fonte);
    bareOk = await criarBare(fonte, false);
    bareRO = await criarBare(fonte, true);
    fixturesFs.push(bareOk, bareRO);

    sistemaOk = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, criarSecretStore(), tenantA, {
        nome: 'Sistema OK',
        git_repo_url: bareOk,
        git_branch_padrao: 'main',
      }),
    );
    sistemaRO = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, criarSecretStore(), tenantA, {
        nome: 'Sistema RO',
        git_repo_url: bareRO,
        git_branch_padrao: 'main',
      }),
    );

    // ---- GATE a) tenant DESABILITADO → não tenta -------------------------
    console.log('\n[gate a] tenant desabilitado');
    await setFlag(false);
    const chGateOff = await abrir(atorCli, 'Erro ao salvar [[resolver]] gate-off', sistemaOk);
    ok((await triar(chGateOff)).status === 'concluido', 'triagem concluída (gate off)');
    {
      const info = await infoChamado(chGateOff);
      const branch = nomeBranchResolucao(info.numero, info.titulo);
      ok(!(await branchesBare(bareOk)).includes(branch), 'nenhuma branch criada (tenant off)');
      await runInTenantContext(ds, tenantA, async (em) => {
        const evs = await listarEventos(em, atorOp, chGateOff);
        ok(!evs.some((e) => e.tipo === 'ia_abriu_pr'), 'sem evento ia_abriu_pr (tenant off)');
        ok(info.status === StatusChamado.em_atendimento, 'chamado em_atendimento (diagnóstico ok)');
      });
    }

    // ---- GATE b) complexidade MEDIA → não tenta --------------------------
    console.log('\n[gate b] complexidade media');
    await setFlag(true);
    const chMedio = await abrir(
      atorCli,
      'Erro ao salvar [[resolver]][[complexidade:medio]]',
      sistemaOk,
    );
    ok((await triar(chMedio)).status === 'concluido', 'triagem concluída (medio)');
    {
      const info = await infoChamado(chMedio);
      const branch = nomeBranchResolucao(info.numero, info.titulo);
      ok(
        !(await branchesBare(bareOk)).includes(branch),
        'nenhuma branch criada (complexidade medio)',
      );
      await runInTenantContext(ds, tenantA, async (em) => {
        const evs = await listarEventos(em, atorOp, chMedio);
        ok(!evs.some((e) => e.tipo === 'ia_abriu_pr'), 'sem evento ia_abriu_pr (medio)');
      });
    }

    // ---- GATE c) natureza ALTERACAO → não tenta --------------------------
    console.log('\n[gate c] natureza alteracao');
    const chAlt = await abrir(
      atorCli,
      'Adicionar filtro [[resolver]]',
      sistemaOk,
      Natureza.alteracao,
    );
    ok((await triar(chAlt)).status === 'concluido', 'triagem concluída (alteracao)');
    {
      const info = await infoChamado(chAlt);
      const branch = nomeBranchResolucao(info.numero, info.titulo);
      ok(
        !(await branchesBare(bareOk)).includes(branch),
        'nenhuma branch criada (natureza alteracao)',
      );
      await runInTenantContext(ds, tenantA, async (em) => {
        const evs = await listarEventos(em, atorOp, chAlt);
        ok(!evs.some((e) => e.tipo === 'ia_abriu_pr'), 'sem evento ia_abriu_pr (alteracao)');
        ok(
          evs.some((e) => e.tipo === 'ia_gerou_spec'),
          'gerou SPEC (fluxo de alteracao segue normal)',
        );
      });
    }

    // ---- FLUXO COMPLETO: problema + facil + tenant habilitado ------------
    console.log('\n[fluxo completo] PR simulado (bare local)');
    const chPr = await abrir(atorCli, 'Corrige erro 500 ao salvar [[resolver]]', sistemaOk);
    ok((await triar(chPr)).status === 'concluido', 'triagem concluída (resolução)');
    const infoPr = await infoChamado(chPr);
    const branchPr = nomeBranchResolucao(infoPr.numero, infoPr.titulo);

    // Branch criada no BARE com o commit esperado.
    ok((await branchesBare(bareOk)).includes(branchPr), `branch ${branchPr} criada no bare`);
    const arquivoCommit = await simpleGit(bareOk).raw(['show', `${branchPr}:CORRECAO-IA.md`]);
    ok(/Correção automática/.test(arquivoCommit), 'commit contém CORRECAO-IA.md com o conteúdo');
    const msgCommit = await simpleGit(bareOk).raw(['log', branchPr, '-1', '--pretty=%s%n%b']);
    ok(
      msgCommit.includes(`chamado #${infoPr.numero}`) && /ExecucaoIA:/.test(msgCommit),
      'mensagem de commit referencia chamado + ExecucaoIA',
    );

    // Nota interna + evento + ExecucaoIA + visibilidade do cliente.
    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chPr);
      const notaPr = msgs.find(
        (m) => vis(m) === 'interna' && /Pull Request aguardando revis/i.test(corpo(m)),
      );
      ok(!!notaPr, 'nota INTERNA de resolução publicada');
      ok(notaPr ? corpo(notaPr).includes(branchPr) : false, 'nota interna cita a branch');

      const evs = await listarEventos(em, atorOp, chPr);
      const evPr = evs.find((e) => e.tipo === 'ia_abriu_pr');
      ok(!!evPr, 'evento ia_abriu_pr registrado');
      ok(
        !!evPr && (evPr.dados as { branch?: string }).branch === branchPr,
        'payload do evento traz a branch',
      );
      ok(
        !!evPr && (evPr.dados as { situacao?: string }).situacao === 'push_sem_pr',
        'situacao = push_sem_pr (host não-GitHub → PR manual)',
      );

      const rows: Array<{ status: string; resultado: { tentativaResolucao?: unknown } | null }> =
        await em.query(`SELECT status, resultado FROM execucao_ia WHERE chamado_id = $1`, [chPr]);
      ok(rows[0]?.status === 'concluido', 'ExecucaoIA.status = concluido');
      const tent = rows[0]?.resultado?.tentativaResolucao as
        { branch?: string; situacao?: string; arquivosAlterados?: string[] } | undefined;
      ok(!!tent && tent.branch === branchPr, 'ExecucaoIA.resultado tem a tentativa (branch)');
      ok(
        !!tent &&
          Array.isArray(tent.arquivosAlterados) &&
          tent.arquivosAlterados.includes('CORRECAO-IA.md'),
        'tentativa registra o arquivo alterado',
      );

      // Cliente NÃO vê a nota interna nem o evento ia_abriu_pr.
      const comoCliente = await listarMensagens(em, atorCli, chPr);
      ok(
        comoCliente.every((m) => vis(m) === undefined || vis(m) === 'publica'),
        'cliente NÃO vê a nota interna do PR',
      );
      const evsCliente = await listarEventos(em, atorCli, chPr);
      ok(!evsCliente.some((e) => e.tipo === 'ia_abriu_pr'), 'cliente NÃO vê o evento ia_abriu_pr');

      // Dashboard lista o PR pendente (operador).
      const prs = await prsIaAguardandoRevisao(em, atorOp);
      ok(
        prs.some((p) => p.id === chPr && p.branch === branchPr),
        'dashboard lista o PR da IA aguardando revisão',
      );
      // Cliente não enxerga PRs da IA (read-only escopado a operador/admin).
      const prsCliente = await prsIaAguardandoRevisao(em, atorCli);
      ok(prsCliente.length === 0, 'cliente não vê a lista de PRs da IA');
    });

    // Cache INTACTO e LIMPO (sem credencial no .git/config, sem a branch ia/).
    const cacheDir = join(CACHE_DIR, tenantA, sistemaOk);
    const cacheConfig = await fs.readFile(join(cacheDir, '.git', 'config'), 'utf8');
    ok(
      !/https?:\/\/[^\s/]*:[^\s/]*@/.test(cacheConfig) && !/token|password/i.test(cacheConfig),
      'cache .git/config SEM credencial',
    );
    const cacheBranches = (await simpleGit(cacheDir).branch(['-a'])).all;
    ok(
      !cacheBranches.some((b) => b.includes(branchPr)),
      'cache intacto (sem a branch de resolução)',
    );

    // Working copy descartável destruída (nenhum resíduo além do baseline).
    ok(
      (await contarDescartaveis()) <= baselineDescartaveis,
      'working copies descartáveis destruídas',
    );

    // ---- FALHA de push (origin somente-leitura) --------------------------
    console.log('\n[falha de push] origin somente-leitura');
    const chFail = await abrir(atorCli, 'Corrige bug ao exportar [[resolver]]', sistemaRO);
    ok((await triar(chFail)).status === 'concluido', 'triagem concluída (diagnóstico intacto)');
    const infoFail = await infoChamado(chFail);
    const branchFail = nomeBranchResolucao(infoFail.numero, infoFail.titulo);
    ok(
      !(await branchesBare(bareRO)).includes(branchFail),
      'push rejeitado → sem branch no bare RO',
    );
    ok(infoFail.status === StatusChamado.em_atendimento, 'chamado em_atendimento (não preso)');
    ok(infoFail.complexidade === Complexidade.facil, 'diagnóstico aplicado (complexidade facil)');
    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chFail);
      ok(
        msgs.some((m) => vis(m) === 'interna' && /Diagn[óo]stico autom/i.test(corpo(m))),
        'nota de diagnóstico permanece',
      );
      ok(
        msgs.some(
          (m) => vis(m) === 'interna' && /Tentativa de resolu.* N.O conclu/i.test(corpo(m)),
        ),
        'nota INTERNA de FALHA da tentativa publicada',
      );
      const evs = await listarEventos(em, atorOp, chFail);
      ok(
        evs.some(
          (e) => e.tipo === 'ia_falhou' && (e.dados as { etapa?: string }).etapa === 'resolucao',
        ),
        'evento ia_falhou (etapa=resolucao) registrado',
      );
      ok(!evs.some((e) => e.tipo === 'ia_abriu_pr'), 'sem evento ia_abriu_pr na falha');
      const rows: Array<{
        status: string;
        resultado: { tentativaResolucao?: { situacao?: string } } | null;
      }> = await em.query(`SELECT status, resultado FROM execucao_ia WHERE chamado_id = $1`, [
        chFail,
      ]);
      ok(rows[0]?.status === 'concluido', 'ExecucaoIA concluido (o diagnóstico foi entregue)');
      ok(
        rows[0]?.resultado?.tentativaResolucao?.situacao === 'falhou',
        'tentativa registrada como situacao=falhou',
      );
      // Falha de resolução NÃO aparece como PR pendente no dashboard.
      const prs = await prsIaAguardandoRevisao(em, atorOp);
      ok(!prs.some((p) => p.id === chFail), 'falha de push não vira PR pendente no dashboard');
    });

    console.log('\n[smoke-resolucao] RESULTADO: PASSOU — resolução automática via PR confirmada.');
  } finally {
    await DespachanteNotificacoes.fechar().catch(() => {});
    redis.disconnect();
    for (const d of [...fixturesFs, CACHE_DIR].filter(Boolean)) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
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
      console.warn('[smoke-resolucao] aviso: limpeza parcial:', e);
    }
    await admin.destroy();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-resolucao] RESULTADO: FALHOU —', err?.message ?? err);
  process.exit(1);
});
