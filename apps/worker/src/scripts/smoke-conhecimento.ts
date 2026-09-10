/**
 * Smoke do CONHECIMENTO DO SISTEMA (D-013). IA_PROVIDER=fake, pipeline INLINE
 * (chama o processador direto — NÃO enfileira no Redis compartilhado, para não
 * competir com o worker do usuário), tenants DESCARTÁVEIS. Prova:
 *
 *   1) Primeira triagem de um sistema-alvo com repo GERA o mapa: 2 ExecucoesIA
 *      (mapeamento + triagem). O mapeamento cita a "regra de negócio" do fixture;
 *      o resumo é INJETADO na triagem (o fake ecoa o marcador [[mapa-fake]] no
 *      diagnóstico). A execução de mapeamento tem sistema_alvo_id e chamado_id NULL.
 *   2) Segunda triagem no MESMO commit NÃO re-mapeia (continua 1 mapeamento).
 *   3) Novo commit no fixture → a triagem NÃO espera o re-mapa (D-033): segue com o
 *      mapa anterior (continua 1 mapeamento) e ENFILEIRA um job em `mapeamento-ia`
 *      (verificado e removido da fila aqui mesmo, para não vazar ao worker do usuário).
 *   4) "Mapear agora" (job manual, processado inline) gera o 2º mapeamento; o commit
 *      persistido muda para o novo.
 *   5) RLS: outro tenant não enxerga as execuções de mapeamento do primeiro.
 *
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
process.env.SISTEMAS_PERMITIR_REPO_LOCAL = 'true';
if (!process.env.SECRET_STORE_MASTER_KEY || process.env.SECRET_STORE_MASTER_KEY.trim() === '') {
  process.env.SECRET_STORE_MASTER_KEY = randomBytes(32).toString('base64');
}
const CACHE_DIR = join(tmpdir(), `chamados-smoke-conh-cache-${randomBytes(4).toString('hex')}`);
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
  listarExecucoesDoSistema,
  DespachanteNotificacoes,
  filaMapeamento,
  jobIdMapeamento,
  fecharFilaMapeamento,
} = await import('@chamados/db');
const { Papel, StatusTenant, Natureza } = await import('@chamados/shared');
const { processarTriagem } = await import('../triagem/processador');
const { processarMapeamentoJob } = await import('../filas/mapeamento-ia');
const { resolverProvider } = await import('../ia/resolver-provider');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const log = (): void => {};

const LIMITES = { timeoutMs: 30_000, budgetUsd: 1, maxTurnos: 5 };
const MAPA = { timeoutMs: 30_000, budgetUsd: 5, maxTurnos: 10, maxChars: 12_000 };
const LOCK = { ttlMs: 60_000, esperaMaxMs: 5_000, intervaloMs: 100 };

/** Cria o repositório fixture com uma "regra de negócio" clara num arquivo. */
async function criarRepoFixture(): Promise<string> {
  const dir = join(tmpdir(), `chamados-smoke-conh-repo-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    join(dir, 'src', 'regras.js'),
    '// REGRA_NEGOCIO: pedidos acima de R$ 1000 exigem aprovação do gerente.\n' +
      'export function precisaAprovacao(valor) {\n  return valor > 1000;\n}\n',
  );
  await fs.writeFile(join(dir, 'README.md'), '# Sistema de Pedidos\n');
  const g = simpleGit(dir);
  // Branch explícita: o sistema-alvo do smoke usa `main` (default do cadastro) e o
  // `init.defaultBranch` da máquina pode ser `master`.
  await g.init(['--initial-branch=main']);
  await g.addConfig('user.email', 'fixture@smoke.dev');
  await g.addConfig('user.name', 'Fixture Smoke');
  await g.add('.');
  await g.commit('commit inicial');
  return dir;
}

async function novoCommit(dir: string): Promise<void> {
  await fs.writeFile(join(dir, 'src', 'novo.js'), "export const x = 'v2';\n");
  const g = simpleGit(dir);
  await g.add('.');
  await g.commit('segundo commit');
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
  console.log('[smoke-conhecimento] conectado (role da app) + Redis + admin.');

  const provider = resolverProvider({ provider: 'fake', modelo: 'ignorado' });
  const deps = { ds, redis, provider, limites: LIMITES, mapa: MAPA, lock: LOCK, log };

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';
  let repoDir = '';

  /** Conta execuções de mapeamento de um sistema (RLS por tenant). */
  async function contarMapeamentos(tenantId: string, sistemaAlvoId: string): Promise<number> {
    return runInTenantContext(ds, tenantId, async (em) => {
      const r: Array<{ n: string }> = await em.query(
        `SELECT count(*)::text AS n FROM execucao_ia
          WHERE sistema_alvo_id = $1 AND gatilho = 'mapeamento'`,
        [sistemaAlvoId],
      );
      return Number(r[0]?.n ?? '0');
    });
  }

  /** Commit persistido no mapa do sistema (`sistema_alvo.conhecimento_commit`). */
  async function lerCommitPersistido(
    tenantId: string,
    sistemaAlvoId: string,
  ): Promise<string | null> {
    return runInTenantContext(ds, tenantId, async (em) => {
      const r: Array<{ c: string | null }> = await em.query(
        `SELECT conhecimento_commit AS c FROM sistema_alvo WHERE id = $1`,
        [sistemaAlvoId],
      );
      return r[0]?.c ?? null;
    });
  }

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-conh-a-${sufixo}`,
      nome: 'Conh A',
      nomeExibicao: 'Conh A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-conh-b-${sufixo}`,
      nome: 'Conh B',
      nomeExibicao: 'Conh B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    const { cliente, admin: adminUser } = await runInTenantContext(ds, tenantA, async (em) => {
      const cliente = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Cliente A',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const adminUser = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `adm.${sufixo}@a.dev`,
        nome: 'Admin A',
        papel: Papel.admin,
        senha: 'Dev@12345',
      });
      return { cliente, admin: adminUser };
    });
    const atorCli = { id: cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorAdmin = { id: adminUser, tenant_id: tenantA, papel: Papel.admin };

    repoDir = await criarRepoFixture();
    const sistemaAlvoId = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, criarSecretStore(), tenantA, {
        nome: 'Sistema Pedidos',
        git_repo_url: repoDir,
      }),
    );

    async function abrirEtriar(titulo: string): Promise<string> {
      const chamadoId = await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarChamado(em, atorCli, {
          titulo,
          descricao: 'x',
          natureza: Natureza.problema,
          sistema_alvo_id: sistemaAlvoId,
        });
        if (!r.ok) throw new Error(`falha ao criar chamado: ${r.motivo}`);
        return r.id;
      });
      const res = await processarTriagem(
        { tenantId: tenantA, chamadoId, ultimaMensagemId: null, gatilho: 'chamado_criado' },
        deps,
      );
      ok(res.status === 'concluido', `triagem "${titulo}" → concluido`);
      return chamadoId;
    }

    // ---- 1) Primeira triagem: gera o mapa + injeta o resumo ----------------
    console.log('\n[1] primeira triagem gera o mapa e injeta o resumo');
    const ch1 = await abrirEtriar('Pedido acima de 1000 não pede aprovação');
    ok((await contarMapeamentos(tenantA, sistemaAlvoId)) === 1, 'gerou 1 execução de mapeamento');
    await runInTenantContext(ds, tenantA, async (em) => {
      const s: Array<{ resumo: string | null; commit: string | null }> = await em.query(
        `SELECT conhecimento_resumo AS resumo, conhecimento_commit AS commit
           FROM sistema_alvo WHERE id = $1`,
        [sistemaAlvoId],
      );
      ok(!!s[0]?.resumo, 'conhecimento_resumo persistido no sistema-alvo');
      ok(/REGRA_NEGOCIO/.test(s[0]!.resumo!), 'resumo cita a regra de negócio (REGRA_NEGOCIO)');
      ok(/src\/regras\.js/.test(s[0]!.resumo!), 'resumo cita o arquivo da regra (src/regras.js)');
      ok(!!s[0]?.commit, 'conhecimento_commit persistido');

      const map: Array<{ chamado_id: string | null; sistema_alvo_id: string | null }> =
        await em.query(
          `SELECT chamado_id, sistema_alvo_id FROM execucao_ia
            WHERE sistema_alvo_id = $1 AND gatilho = 'mapeamento'`,
          [sistemaAlvoId],
        );
      ok(
        map[0]?.chamado_id === null && map[0]?.sistema_alvo_id === sistemaAlvoId,
        'execução de mapeamento: chamado_id NULL e sistema_alvo_id preenchido (XOR)',
      );

      const diag: Array<{ d: string | null }> = await em.query(
        `SELECT resultado->>'diagnostico' AS d FROM execucao_ia WHERE chamado_id = $1`,
        [ch1],
      );
      ok(
        !!diag[0]?.d && /\[\[mapa-fake\]\]/.test(diag[0]!.d!),
        'diagnóstico da triagem ECOA o conhecimento injetado ([[mapa-fake]])',
      );
    });

    // ---- 2) Segunda triagem no mesmo commit NÃO re-mapeia ------------------
    console.log('\n[2] segunda triagem (mesmo commit) não re-mapeia');
    await abrirEtriar('Outro chamado sobre pedidos');
    ok(
      (await contarMapeamentos(tenantA, sistemaAlvoId)) === 1,
      'continua com 1 mapeamento (commit inalterado → sem re-mapa)',
    );

    // ---- 3) Novo commit no fixture → re-mapa ENFILEIRADO, triagem segue ----
    console.log('\n[3] novo commit no fixture → re-mapa enfileirado (D-033), triagem segue');
    await novoCommit(repoDir);
    const commitAntes = await lerCommitPersistido(tenantA, sistemaAlvoId);
    await abrirEtriar('Chamado após novo commit');
    ok(
      (await contarMapeamentos(tenantA, sistemaAlvoId)) === 1,
      'triagem NÃO re-mapeou inline (continua 1 mapeamento; seguiu com o mapa anterior)',
    );
    ok(
      (await lerCommitPersistido(tenantA, sistemaAlvoId)) === commitAntes,
      'commit persistido ainda é o anterior (o mapa novo vem pela fila)',
    );
    const jobEnfileirado = await filaMapeamento().getJob(jobIdMapeamento(sistemaAlvoId));
    ok(jobEnfileirado != null, 'job de re-mapeamento ENFILEIRADO em mapeamento-ia');
    // Remove o job para o worker do usuário (se estiver rodando) não o consumir.
    await jobEnfileirado!.remove().catch(() => {});

    // ---- 4) "Mapear agora" (job manual, inline) ----------------------------
    console.log('\n[4] job manual "Mapear agora" → 2º mapeamento, commit novo');
    const rMap = await processarMapeamentoJob(
      { tenantId: tenantA, sistemaAlvoId },
      { ds, redis, provider, limites: MAPA, lock: LOCK, log },
    );
    ok(rMap.status === 'concluido', 'job manual de mapeamento concluído');
    ok((await contarMapeamentos(tenantA, sistemaAlvoId)) === 2, 'job manual gerou o 2º mapeamento');
    ok(
      (await lerCommitPersistido(tenantA, sistemaAlvoId)) !== commitAntes,
      'commit persistido mudou para o novo',
    );

    // ---- 5) RLS: outro tenant não vê as execuções do primeiro --------------
    console.log('\n[5] RLS');
    const vistas = await runInTenantContext(ds, tenantB, (em) =>
      listarExecucoesDoSistema(
        em,
        { id: adminUser, tenant_id: tenantB, papel: Papel.admin },
        sistemaAlvoId,
      ),
    );
    ok(vistas.length === 0, 'tenant B NÃO enxerga as execuções de mapeamento do tenant A (RLS)');

    // Sanidade: o admin do tenant A enxerga as 2.
    const vistasA = await runInTenantContext(ds, tenantA, (em) =>
      listarExecucoesDoSistema(em, atorAdmin, sistemaAlvoId, { limite: 10 }),
    );
    ok(vistasA.length === 2, 'admin do tenant A enxerga as 2 execuções de mapeamento');

    console.log('\n[smoke-conhecimento] RESULTADO: PASSOU — conhecimento do sistema confirmado.');
  } finally {
    await fecharFilaMapeamento().catch(() => {});
    await DespachanteNotificacoes.fechar().catch(() => {});
    redis.disconnect();
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
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
      console.warn('[smoke-conhecimento] aviso: limpeza parcial:', e);
    }
    await admin.destroy();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-conhecimento] RESULTADO: FALHOU —', err?.message ?? err);
  process.exit(1);
});
