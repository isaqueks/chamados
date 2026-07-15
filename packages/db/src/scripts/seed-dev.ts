/**
 * Provisiona um tenant de desenvolvimento completo e idempotente:
 *   tenant "acme" + admin + operador + cliente + agente_ia (service account).
 *
 * As senhas de dev são conhecidas e IMPRESSAS no console (apenas dev). Reexecutar
 * não duplica nada. Acesse pelo subdomínio: http://acme.localhost:3000/login
 */
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const {
  provisionarTenant,
  atualizarStatusTenant,
  criarUsuarioAtivoComSenha,
  existeContaPorEmail,
} = await import('../auth');
const { Papel, StatusTenant } = await import('@chamados/shared');

const SLUG = 'acme';
const SENHA_DEV = 'Dev@12345';
const HUMANOS = [
  { papel: Papel.admin, email: 'admin@acme.dev', nome: 'Alice Admin' },
  { papel: Papel.operador, email: 'operador@acme.dev', nome: 'Otávio Operador' },
  { papel: Papel.cliente, email: 'cliente@acme.dev', nome: 'Carla Cliente' },
] as const;

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[seed-dev] conectado como role da aplicação (sem bypass).');

  try {
    // 1) Provisiona o tenant (cria agente_ia automaticamente). Idempotente.
    const prov = await provisionarTenant(ds, {
      slug: SLUG,
      nome: 'ACME Ltda',
      nomeExibicao: 'ACME Suporte',
      status: StatusTenant.em_provisionamento,
    });
    console.log(
      `[seed-dev] tenant ${SLUG} ${prov.criado ? 'criado' : 'já existia'} (id=${prov.tenant_id}); ` +
        `agente_ia=${prov.agente_ia_id}; categoria_geral=${prov.categoria_geral_id}`,
    );

    // 2) Cria os usuários humanos (idempotente por e-mail).
    await runInTenantContext(ds, prov.tenant_id, async (em) => {
      for (const h of HUMANOS) {
        if (await existeContaPorEmail(em, h.email)) {
          console.log(`[seed-dev]   • ${h.papel.padEnd(9)} ${h.email} (já existe)`);
          continue;
        }
        await criarUsuarioAtivoComSenha(em, {
          tenant_id: prov.tenant_id,
          email: h.email,
          nome: h.nome,
          papel: h.papel,
          senha: SENHA_DEV,
        });
        console.log(`[seed-dev]   • ${h.papel.padEnd(9)} ${h.email} (criado)`);
      }
    });

    // 3) Ativa o tenant (setup concluído).
    await atualizarStatusTenant(ds, prov.tenant_id, StatusTenant.ativo);

    console.log('\n[seed-dev] PRONTO. Acesse: http://acme.localhost:3000/login');
    console.log('[seed-dev] Credenciais de dev (senha comum a todos):');
    for (const h of HUMANOS) {
      console.log(`[seed-dev]   ${h.papel.padEnd(9)} ${h.email}  /  ${SENHA_DEV}`);
    }
    console.log(
      '[seed-dev]   agente_ia  (service account — sem login por senha; credencial no cofre se AGENTE_IA_TOKEN estiver setado)',
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[seed-dev] erro:', err);
  process.exit(1);
});
