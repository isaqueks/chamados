import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { carregarConfig, ErroConfig } from '../config';
import { abrirBanco, caminhoBanco, criarDataSource, ErroMigracao, reverterUltima } from '../db';

/**
 * Migrations manuais do SQLite da Forja (specs/forja/02 §1):
 * `npm run migration:run|migration:revert -w @chamados/forja`.
 *
 * `run` faz exatamente o que o boot faz (backup por `VACUUM INTO` se houver
 * pendente num banco existente, migrations em transação, `foreign_key_check`);
 * `revert` desfaz a última, também com backup antes. O diretório de dados é o
 * da configuração (`FORJA_DADOS_DIR`/`FORJA_MODO`), nunca um caminho solto:
 * rodar com `FORJA_MODO=dev` mexe só em `forja-dev/`.
 */

async function principal(acao: string | undefined): Promise<number> {
  if (acao !== 'run' && acao !== 'revert') {
    console.error('uso: migrar.ts run|revert');
    return 1;
  }
  const config = carregarConfig();
  console.log(`[forja] banco: ${caminhoBanco(config.dirDados)}`);

  if (acao === 'run') {
    const banco = await abrirBanco(config);
    const { aplicadas, backup } = banco.migracao;
    if (backup) console.log(`[forja] backup: ${backup}`);
    console.log(
      aplicadas.length > 0
        ? `[forja] aplicadas: ${aplicadas.join(', ')}`
        : '[forja] nenhuma migration pendente',
    );
    await banco.fechar();
    return 0;
  }

  mkdirSync(config.dirDados, { recursive: true, mode: 0o700 });
  const ds = criarDataSource(caminhoBanco(config.dirDados));
  await ds.initialize();
  try {
    const { backup } = await reverterUltima(ds, config.dirDados, new Date());
    console.log(`[forja] backup: ${backup}`);
    console.log('[forja] última migration revertida');
  } finally {
    await ds.destroy();
  }
  return 0;
}

principal(process.argv[2])
  .then((codigo) => process.exit(codigo))
  .catch((erro: unknown) => {
    if (erro instanceof ErroConfig) {
      console.error(`[forja] configuração inválida: ${erro.message}`);
    } else if (erro instanceof ErroMigracao) {
      console.error(`[forja] ${erro.message}`);
    } else {
      console.error('[forja] falha:', erro);
    }
    process.exit(2);
  });
