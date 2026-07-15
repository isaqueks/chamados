/**
 * Smoke test do cofre de segredos (SecretStore — specs/07 §5.2, specs/09 §7).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) e prova:
 *  1. roundtrip: guardar → ler devolve o mesmo valor (envelope AES-256-GCM);
 *  2. o valor NUNCA é persistido em claro (a coluna cifrada não contém o texto);
 *  3. substituir troca o valor sob a MESMA referência (rotação);
 *  4. isolamento RLS: o tenant B NÃO resolve uma referência do tenant A;
 *  5. remover apaga o segredo.
 *
 * Requer SECRET_STORE_MASTER_KEY no ambiente. Sai com 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { TenantSchema } = await import('../entities/tenant');
const { SegredoSchema } = await import('../entities/segredo');
const { criarSecretStore } = await import('../secrets/secret-store');
const { StatusTenant } = await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function inserirTenant(
  ds: import('typeorm').DataSource,
  id: string,
  slug: string,
): Promise<void> {
  await runInTenantContext(ds, id, async (em) => {
    await em.insert(TenantSchema, {
      id,
      slug,
      nome: slug,
      nome_exibicao: slug,
      status: StatusTenant.ativo,
    });
  });
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-secrets] conectado como role da aplicação (sem bypass).');

  const store = criarSecretStore();
  const sufixo = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const SEGREDO = `s3nha-super-secreta-${sufixo}`;
  const SEGREDO_NOVO = `rotacionada-${sufixo}`;
  let refA = '';

  try {
    await inserirTenant(ds, tenantA, `smoke-sec-a-${sufixo}`);
    await inserirTenant(ds, tenantB, `smoke-sec-b-${sufixo}`);

    // 1) Roundtrip -----------------------------------------------------------
    refA = await runInTenantContext(ds, tenantA, (em) =>
      store.guardar(em, tenantA, SEGREDO),
    );
    ok(!!refA, 'guardar retornou uma referência (id do segredo)');

    const lido = await runInTenantContext(ds, tenantA, (em) => store.ler(em, refA));
    ok(lido === SEGREDO, 'ler devolve exatamente o valor guardado (roundtrip)');

    // 2) Nunca em claro no banco --------------------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const linha = await em.findOne(SegredoSchema, { where: { id: refA } });
      ok(!!linha, 'a linha cifrada existe');
      ok(
        !linha!.valor_cifrado.includes(SEGREDO),
        'a coluna valor_cifrado NÃO contém o segredo em claro',
      );
      ok(
        !linha!.dek_cifrada.includes(SEGREDO),
        'a coluna dek_cifrada NÃO contém o segredo em claro',
      );
    });

    // 3) Rotação sob a mesma referência -------------------------------------
    await runInTenantContext(ds, tenantA, (em) =>
      store.substituir(em, refA, SEGREDO_NOVO),
    );
    const lido2 = await runInTenantContext(ds, tenantA, (em) => store.ler(em, refA));
    ok(lido2 === SEGREDO_NOVO, 'substituir troca o valor mantendo a mesma referência');

    // 4) Isolamento RLS entre tenants ---------------------------------------
    const noB = await runInTenantContext(ds, tenantB, (em) => store.ler(em, refA));
    ok(noB === null, 'tenant B NÃO resolve a referência do tenant A (RLS)');
    await runInTenantContext(ds, tenantB, async (em) => {
      const cnt = await em.count(SegredoSchema);
      ok(cnt === 0, 'tenant B não enxerga nenhum segredo do tenant A');
    });

    // 5) Remoção -------------------------------------------------------------
    await runInTenantContext(ds, tenantA, (em) => store.remover(em, refA));
    const apos = await runInTenantContext(ds, tenantA, (em) => store.ler(em, refA));
    ok(apos === null, 'remover apaga o segredo (ler devolve null)');

    console.log('\n[smoke-secrets] RESULTADO: PASSOU — cofre de segredos confirmado.');
  } finally {
    try {
      await runInTenantContext(ds, tenantA, async (em) => {
        await em.delete(SegredoSchema, { tenant_id: tenantA });
        await em.delete(TenantSchema, { id: tenantA });
      });
      await runInTenantContext(ds, tenantB, async (em) => {
        await em.delete(SegredoSchema, { tenant_id: tenantB });
        await em.delete(TenantSchema, { id: tenantB });
      });
    } catch (e) {
      console.warn('[smoke-secrets] aviso: limpeza parcial:', e);
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-secrets] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
