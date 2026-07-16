/**
 * Worker BullMQ do Chamados (M6 — infra de IA, specs/01 §3.3/§3.5, specs/05).
 *
 * Processo Node ISOLADO do web app (falha/lentidão da IA nunca degrada o request
 * síncrono). Estrutura MODULAR: cada fila tem seu `registrar()` em `src/filas/*`;
 * o `index` só inicializa dependências (DataSource, Redis, provider) e registra
 * as filas. O M9 adiciona `src/filas/notificacoes.ts` chamando outro `registrar()`
 * aqui, sem tocar na triagem.
 */
import './env'; // PRIMEIRO import: carrega o .env da raiz antes de qualquer config.
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { criarAppDataSource } from '@chamados/db';
import { redisConnection, iaConfig, triagemConfig } from './config';
import { resolverProvider } from './ia/resolver-provider';
import { registrarTriagemIA } from './filas/triagem-ia';
import { registrarNotificacoes } from './filas/notificacoes';
import { registrarManutencao, manutencaoConfigEnv } from './filas/manutencao';
import { registryPadrao } from './notificacoes/registry';
import { notificacoesConfig } from './notificacoes/config';

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), servico: 'worker', msg, ...extra }));
}

async function main(): Promise<void> {
  log('iniciando worker', {
    redis: `${redisConnection.host}:${redisConnection.port}`,
    ia_provider: iaConfig.provider,
  });

  // Dependências compartilhadas pelas filas.
  const ds = criarAppDataSource();
  await ds.initialize();
  const redis = new Redis({ ...redisConnection, maxRetriesPerRequest: null });
  const provider = resolverProvider({
    provider: iaConfig.provider,
    modelo: iaConfig.modelo,
    apiKey: iaConfig.apiKey,
    oauthToken: iaConfig.oauthToken,
    log,
  });
  log('provider de IA resolvido', { nome: provider.nome, modelo: provider.modelo });

  // Registro modular das filas (M9 adiciona notificacoes aqui).
  const workers: Worker[] = [
    registrarTriagemIA({
      ds,
      redis,
      provider,
      limites: iaConfig.limites,
      lock: triagemConfig.lock,
      connection: redisConnection,
      concorrencia: triagemConfig.concorrencia,
      log,
      resolucao: {
        prTimeoutMs: iaConfig.resolucao.prTimeoutMs,
        appBaseUrl: iaConfig.resolucao.appBaseUrl,
      },
    }),
    // M9 — fila de notificações (SMTP + webhook, templates, idempotência).
    registrarNotificacoes({
      ds,
      registry: registryPadrao({
        smtp: notificacoesConfig.smtp,
        webhookTimeoutMs: notificacoesConfig.webhook.timeoutMs,
      }),
      config: notificacoesConfig,
      connection: redisConnection,
      concorrencia: notificacoesConfig.concorrencia,
      log,
    }),
  ];

  // M10 — fila de manutenção: auto-fechamento de `resolvido` vencidos (repetível,
  // varredura por tenant com lock global). `registrarManutencao` é async porque
  // agenda o job scheduler antes de subir o worker.
  const cfgManutencao = manutencaoConfigEnv();
  workers.push(
    await registrarManutencao({
      ds,
      redis,
      connection: redisConnection,
      intervaloMs: cfgManutencao.intervaloMs,
      lockTtlMs: cfgManutencao.lockTtlMs,
      log,
    }),
  );

  // ---- Encerramento limpo ------------------------------------------------
  let encerrando = false;
  const encerrar = async (sinal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    log('encerrando', { sinal });
    try {
      await Promise.all(workers.map((w) => w.close()));
      await redis.quit();
      await ds.destroy();
      log('encerrado com sucesso');
      process.exit(0);
    } catch (err) {
      log('erro no encerramento', { erro: (err as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

main().catch((err) => {
  log('falha fatal na inicialização', { erro: (err as Error).message });
  process.exit(1);
});
