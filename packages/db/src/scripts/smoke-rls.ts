/**
 * Smoke test de isolamento por Row-Level Security.
 *
 * Prova, usando o ROLE DA APLICAÇÃO (SEM BYPASSRLS), que:
 *  - é possível criar 2 tenants + 1 usuário em cada (cada um no seu contexto);
 *  - dentro de runInTenantContext(tenantA) só se enxerga o usuário do tenant A
 *    (e o próprio tenant A), nunca dados do tenant B.
 *
 * Sai com código 0 se o isolamento vale; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { TenantSchema } = await import('../entities/tenant');
const { UsuarioSchema } = await import('../entities/usuario');
const { Papel, StatusTenant, StatusUsuario } = await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-rls] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const emailA = `ana.${sufixo}@tenant-a.dev`;
  const emailB = `bruno.${sufixo}@tenant-b.dev`;

  try {
    // ---- Criação: cada tenant no seu próprio contexto -------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      await em.insert(TenantSchema, {
        id: tenantA,
        slug: `smoke-a-${sufixo}`,
        nome: 'Tenant A',
        nome_exibicao: 'Tenant A',
        status: StatusTenant.ativo,
      });
      await em.insert(UsuarioSchema, {
        tenant_id: tenantA,
        email: emailA,
        nome: 'Ana (A)',
        papel: Papel.admin,
        status: StatusUsuario.ativo,
      });
    });
    console.log('[smoke-rls] tenant A + usuário A criados.');

    await runInTenantContext(ds, tenantB, async (em) => {
      await em.insert(TenantSchema, {
        id: tenantB,
        slug: `smoke-b-${sufixo}`,
        nome: 'Tenant B',
        nome_exibicao: 'Tenant B',
        status: StatusTenant.ativo,
      });
      await em.insert(UsuarioSchema, {
        tenant_id: tenantB,
        email: emailB,
        nome: 'Bruno (B)',
        papel: Papel.admin,
        status: StatusUsuario.ativo,
      });
    });
    console.log('[smoke-rls] tenant B + usuário B criados.');

    // ---- Verificação: contexto de A só enxerga A ------------------------
    console.log('[smoke-rls] verificando isolamento no contexto do tenant A:');
    await runInTenantContext(ds, tenantA, async (em) => {
      const usuarios = await em.find(UsuarioSchema);
      ok(usuarios.length === 1, `vê exatamente 1 usuário (viu ${usuarios.length})`);
      ok(usuarios[0]?.tenant_id === tenantA, 'o usuário visível é do tenant A');
      ok(usuarios[0]?.email === emailA, 'é o e-mail do usuário A');
      ok(
        !usuarios.some((u) => u.email === emailB),
        'NÃO enxerga o usuário do tenant B',
      );

      const tenants = await em.find(TenantSchema);
      ok(tenants.length === 1 && tenants[0]?.id === tenantA, 'só vê o próprio tenant A');
    });

    // ---- Verificação simétrica: contexto de B só enxerga B --------------
    console.log('[smoke-rls] verificando isolamento no contexto do tenant B:');
    await runInTenantContext(ds, tenantB, async (em) => {
      const usuarios = await em.find(UsuarioSchema);
      ok(usuarios.length === 1, `vê exatamente 1 usuário (viu ${usuarios.length})`);
      ok(usuarios[0]?.email === emailB, 'é o e-mail do usuário B');
      ok(
        !usuarios.some((u) => u.email === emailA),
        'NÃO enxerga o usuário do tenant A',
      );
    });

    console.log('\n[smoke-rls] RESULTADO: PASSOU — isolamento por RLS confirmado.');
  } finally {
    // ---- Limpeza (hard delete, cada um no seu contexto) -----------------
    try {
      await runInTenantContext(ds, tenantA, async (em) => {
        await em.delete(UsuarioSchema, { tenant_id: tenantA });
        await em.delete(TenantSchema, { id: tenantA });
      });
      await runInTenantContext(ds, tenantB, async (em) => {
        await em.delete(UsuarioSchema, { tenant_id: tenantB });
        await em.delete(TenantSchema, { id: tenantB });
      });
    } catch (e) {
      console.warn('[smoke-rls] aviso: limpeza parcial:', e);
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-rls] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
