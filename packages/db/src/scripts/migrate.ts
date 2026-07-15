import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

// Import dinâmico DEPOIS de carregar o .env, para o config ler as env vars.
const { criarAdminDataSource } = await import('../data-source');

async function main(): Promise<void> {
  const reverter = process.argv.includes('--revert');
  const ds = criarAdminDataSource();
  await ds.initialize();
  try {
    if (reverter) {
      console.log('[migrate] revertendo última migration...');
      await ds.undoLastMigration();
      console.log('[migrate] revert concluído.');
    } else {
      const aplicadas = await ds.runMigrations();
      if (aplicadas.length === 0) {
        console.log('[migrate] nenhuma migration pendente.');
      } else {
        console.log(
          `[migrate] aplicadas: ${aplicadas.map((m) => m.name).join(', ')}`,
        );
      }
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[migrate] erro:', err);
  process.exit(1);
});
