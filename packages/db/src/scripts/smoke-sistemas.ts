/**
 * Smoke test de SistemaAlvo + Categoria (specs/07 §5, specs/02).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) e prova:
 *  1. o provisionamento cria a Categoria geral do tenant;
 *  2. criar sistema-alvo grava as credenciais no cofre (só referências na tabela);
 *  3. as LEITURAS (listar/buscar) NUNCA retornam segredo em claro — só presença;
 *  4. o worker consegue recuperar o segredo pela referência (roundtrip);
 *  5. atualizar rotaciona um segredo e mantém os não informados;
 *  6. a categoria geral é protegida (não renomeável/removível; nome reservado);
 *  7. isolamento RLS: o tenant B não enxerga sistemas do tenant A.
 *
 * Requer SECRET_STORE_MASTER_KEY. Sai com 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource, criarAdminDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { provisionarTenant } = await import('../auth');
const { SistemaAlvoSchema } = await import('../entities/sistema-alvo');
const { criarSecretStore } = await import('../secrets/secret-store');
const { criarSistemaAlvo, atualizarSistemaAlvo, listarSistemasAlvo, buscarSistemaAlvo } =
  await import('../sistemas/sistema-alvo-service');
const {
  listarCategorias,
  criarCategoria,
  removerCategoria,
  editarCategoria,
  NOME_CATEGORIA_GERAL,
} = await import('../categorias/categoria-service');
const { StatusTenant } = await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-sistemas] conectado como role da aplicação (sem bypass).');

  const store = criarSecretStore();
  const sufixo = randomUUID().slice(0, 8);
  const GIT_TOKEN = `ghp_${sufixo}_super_secreto`;
  const BD_CRED = `readonly_user:senha_${sufixo}`;
  const BD_CRED_NOVA = `readonly_user:rotacionada_${sufixo}`;
  let tenantA = '';
  let tenantB = '';

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-sis-a-${sufixo}`,
      nome: 'Sis A',
      nomeExibicao: 'Sis A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-sis-b-${sufixo}`,
      nome: 'Sis B',
      nomeExibicao: 'Sis B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    // 1) Categoria geral no provisionamento ---------------------------------
    ok(!!provA.categoria_geral_id, 'provisionamento retornou a categoria geral');
    await runInTenantContext(ds, tenantA, async (em) => {
      const cats = await listarCategorias(em, { incluirInativas: true });
      ok(
        cats.some((c) => c.nome === NOME_CATEGORIA_GERAL),
        'a categoria "Geral" existe no tenant',
      );
    });

    // 2) Criar sistema-alvo com segredos ------------------------------------
    const sistemaId = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, store, tenantA, {
        nome: 'ERP Financeiro',
        descricao: 'Sistema de ERP',
        git_repo_url: 'https://github.com/acme/erp.git',
        git_credencial: GIT_TOKEN,
        bd_tipo: 'postgres',
        bd_host: 'db.interno',
        bd_porta: 5432,
        bd_nome: 'erp',
        bd_credencial: BD_CRED,
      }),
    );
    ok(!!sistemaId, 'criar sistema-alvo retornou um id');

    // 3) Leituras nunca vazam segredo em claro ------------------------------
    const resumo = await runInTenantContext(ds, tenantA, (em) => buscarSistemaAlvo(em, sistemaId));
    ok(!!resumo, 'buscarSistemaAlvo retornou o resumo');
    ok(resumo!.tem_git_credencial === true, 'resumo indica presença da credencial git');
    ok(resumo!.tem_bd_credencial === true, 'resumo indica presença da credencial de BD');
    const jsonResumo = JSON.stringify(resumo);
    ok(!jsonResumo.includes(GIT_TOKEN), 'resumo NÃO contém o token git em claro');
    ok(!jsonResumo.includes(BD_CRED), 'resumo NÃO contém a credencial de BD em claro');

    const lista = await runInTenantContext(ds, tenantA, (em) =>
      listarSistemasAlvo(em, { incluirInativos: true }),
    );
    ok(!JSON.stringify(lista).includes(GIT_TOKEN), 'listagem NÃO contém nenhum segredo em claro');

    // 4) Worker recupera o segredo pela referência (roundtrip) --------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const linha = await em.findOne(SistemaAlvoSchema, { where: { id: sistemaId } });
      ok(!!linha!.git_credencial_ref, 'a tabela guarda apenas a referência (git)');
      const valor = await store.ler(em, linha!.git_credencial_ref!);
      ok(valor === GIT_TOKEN, 'o cofre devolve o token git original (roundtrip)');
      const valorBd = await store.ler(em, linha!.bd_credencial_ref!);
      ok(valorBd === BD_CRED, 'o cofre devolve a credencial de BD original');
    });

    // 5) Atualizar rotaciona um segredo e mantém os não informados ----------
    await runInTenantContext(ds, tenantA, (em) =>
      atualizarSistemaAlvo(em, store, tenantA, sistemaId, {
        nome: 'ERP Financeiro v2',
        git_repo_url: 'https://github.com/acme/erp.git',
        // git_credencial ausente → mantém; bd_credencial nova → rotaciona
        bd_credencial: BD_CRED_NOVA,
      }),
    );
    await runInTenantContext(ds, tenantA, async (em) => {
      const linha = await em.findOne(SistemaAlvoSchema, { where: { id: sistemaId } });
      ok(linha!.nome === 'ERP Financeiro v2', 'nome foi atualizado');
      const git = await store.ler(em, linha!.git_credencial_ref!);
      ok(git === GIT_TOKEN, 'credencial git não informada foi mantida');
      const bd = await store.ler(em, linha!.bd_credencial_ref!);
      ok(bd === BD_CRED_NOVA, 'credencial de BD foi rotacionada');
    });

    // 5b) Repositório local atrás de flag (D-011) ---------------------------
    // Garante o estado default (flag desligada) para o primeiro cenário.
    delete process.env.SISTEMAS_PERMITIR_REPO_LOCAL;
    const CAMINHO_LOCAL = `/srv/repos/erp-local-${sufixo}`;
    await runInTenantContext(ds, tenantA, async (em) => {
      // Flag OFF → caminho local é REJEITADO com mensagem mencionando a flag.
      let erroFlag: Error | null = null;
      await criarSistemaAlvo(em, store, tenantA, {
        nome: `Local OFF ${sufixo}`,
        git_repo_url: CAMINHO_LOCAL,
      }).catch((e: unknown) => (erroFlag = e as Error));
      ok(erroFlag !== null, 'flag OFF: criar sistema com repo local é REJEITADO');
      ok(
        erroFlag !== null && /SISTEMAS_PERMITIR_REPO_LOCAL/.test((erroFlag as Error).message),
        'a mensagem de erro menciona a flag SISTEMAS_PERMITIR_REPO_LOCAL',
      );
    });

    // Flag ON → caminho local é ACEITO; credencial git é DISPENSADA (limpa mesmo
    // se enviada — o worker nunca injeta credencial numa origem local).
    process.env.SISTEMAS_PERMITIR_REPO_LOCAL = 'true';
    const localId = await runInTenantContext(ds, tenantA, (em) =>
      criarSistemaAlvo(em, store, tenantA, {
        nome: `Local ON ${sufixo}`,
        git_repo_url: CAMINHO_LOCAL,
        git_credencial: 'ghp_deveria_ser_ignorada', // enviada, mas dispensada
      }),
    );
    ok(!!localId, 'flag ON: criar sistema com repo local retorna um id');
    await runInTenantContext(ds, tenantA, async (em) => {
      const linha = await em.findOne(SistemaAlvoSchema, { where: { id: localId } });
      ok(linha!.git_repo_url === CAMINHO_LOCAL, 'o caminho local foi persistido como git_repo_url');
      ok(
        linha!.git_credencial_ref === null,
        'credencial git DISPENSADA no repo local (nenhuma referência gravada)',
      );
      const resumo = await buscarSistemaAlvo(em, localId);
      ok(resumo!.tem_git_credencial === false, 'resumo confirma ausência de credencial git');
    });
    // Restaura o default para não vazar a flag para outras verificações.
    delete process.env.SISTEMAS_PERMITIR_REPO_LOCAL;

    // 6) Proteção da categoria geral ----------------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const cats = await listarCategorias(em, { incluirInativas: true });
      const geral = cats.find((c) => c.nome === NOME_CATEGORIA_GERAL)!;
      const rmv = await removerCategoria(em, geral.id);
      ok(!rmv.ok, 'remover a categoria geral é negado');
      const edt = await editarCategoria(em, geral.id, { nome: 'Outra' });
      ok(!edt.ok, 'editar a categoria geral é negado');
      const dup = await criarCategoria(em, tenantA, { nome: NOME_CATEGORIA_GERAL });
      ok(!dup.ok, 'criar outra categoria "Geral" é negado (nome reservado)');
    });

    // 7) Isolamento RLS -----------------------------------------------------
    await runInTenantContext(ds, tenantB, async (em) => {
      const lst = await listarSistemasAlvo(em, { incluirInativos: true });
      ok(lst.length === 0, 'tenant B não enxerga sistemas do tenant A');
      const busca = await buscarSistemaAlvo(em, sistemaId);
      ok(busca === null, 'tenant B não resolve o sistema-alvo do tenant A por id');
    });

    console.log('\n[smoke-sistemas] RESULTADO: PASSOU — SistemaAlvo/Categoria confirmados.');
  } finally {
    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "sistema_alvo" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "segredo" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-sistemas] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-sistemas] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
