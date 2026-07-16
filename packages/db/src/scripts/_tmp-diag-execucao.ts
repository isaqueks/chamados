/** TEMPORÁRIO — inspeciona a última ExecucaoIA do chamado #8. Deletar após uso. */
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAdminDataSource } = await import('../data-source');

const ds = criarAdminDataSource();
await ds.initialize();
try {
  const rows = await ds.query(
    `SELECT id, status, gatilho, provider, modelo, erro,
            custo_usd, duracao_ms, tokens_entrada, tokens_saida,
            resultado
       FROM execucao_ia
      WHERE chamado_id = $1
      ORDER BY criado_em DESC
      LIMIT 2`,
    ['90cb1444-3843-4da5-b59b-c9cbe578ece6'],
  );
  for (const r of rows) {
    const res = r.resultado ?? {};
    console.log(
      JSON.stringify(
        {
          id: r.id,
          status: r.status,
          provider: r.provider,
          modelo: r.modelo,
          custo_usd: r.custo_usd,
          duracao_ms: r.duracao_ms,
          tokens: { entrada: r.tokens_entrada, saida: r.tokens_saida },
          compreendido: res.compreendido,
          confianca: res.confianca,
          perguntas: res.perguntasAoCliente,
          acoes: res.acoes ?? res.telemetria?.acoes ?? '(sem registro de ações)',
        },
        null,
        2,
      ),
    );
  }
} finally {
  await ds.destroy();
}
