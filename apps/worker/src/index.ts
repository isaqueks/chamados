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
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { criarAppDataSource } from '@chamados/db';
import { redisConnection, iaConfig, triagemConfig } from './config';
import { resolverProvider } from './ia/resolver-provider';
import { registrarTriagemIA } from './filas/triagem-ia';
import { registrarMapeamentoIA } from './filas/mapeamento-ia';
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

  // D-016: presença desta instância no Redis (EX 15s, renovada a cada 5s) +
  // AVISO se já existe outra viva — dois `npm run dev` simultâneos compartilham
  // as filas e multiplicam a concorrência de IA (gatilho do incidente do lock
  // órfão). Só aviso: múltiplas instâncias são legítimas em produção.
  const chaveInstancia = `chamados:worker:instancia:${randomUUID()}`;
  await redis.set(chaveInstancia, '1', 'EX', 15).catch(() => {});
  const timerInstancia = setInterval(() => {
    void redis.set(chaveInstancia, '1', 'EX', 15).catch(() => {});
  }, 5_000);
  timerInstancia.unref();
  try {
    const outras: string[] = [];
    let cursor = '0';
    do {
      const [c, chaves] = await redis.scan(
        cursor,
        'MATCH',
        'chamados:worker:instancia:*',
        'COUNT',
        100,
      );
      cursor = c;
      outras.push(...chaves);
    } while (cursor !== '0');
    const demais = outras.filter((k) => k !== chaveInstancia);
    if (demais.length > 0) {
      log('ATENÇÃO: outra instância do worker está ativa — as filas serão compartilhadas', {
        outrasInstancias: demais.length,
      });
    }
  } catch {
    /* detecção best-effort — nunca impede o boot */
  }

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
      mapa: iaConfig.mapa,
      lock: triagemConfig.lock,
      connection: redisConnection,
      concorrencia: triagemConfig.concorrencia,
      log,
      resolucao: {
        prTimeoutMs: iaConfig.resolucao.prTimeoutMs,
        appBaseUrl: iaConfig.resolucao.appBaseUrl,
      },
    }),
    // D-013 — fila de mapeamento de conhecimento ("Mapear agora"). Fila própria
    // leve; concorrência baixa (mapeamento é caro). Lock por tenant compartilhado
    // com a triagem (1 execução de IA por tenant).
    registrarMapeamentoIA({
      ds,
      redis,
      provider,
      limites: iaConfig.mapa,
      lock: triagemConfig.lock,
      connection: redisConnection,
      concorrencia: 1,
      log,
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
      execucaoOrfaMs: cfgManutencao.execucaoOrfaMs,
      triagemEncalhadaMs: cfgManutencao.triagemEncalhadaMs,
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
      clearInterval(timerInstancia);
      await Promise.all(workers.map((w) => w.close()));
      await redis.del(chaveInstancia).catch(() => {});
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
  // Defesa SECUNDÁRIA (D-016): fecha os workers (jobs ativos liberam o lock no
  // `finally`) mesmo em crash de programação. A garantia primária contra lock
  // órfão é o heartbeat de TTL curto — no Windows, kill não entrega sinal algum.
  process.on('uncaughtException', (err) => {
    log('exceção não tratada — encerrando', { erro: err.message });
    void encerrar('uncaughtException');
  });
  process.on('unhandledRejection', (motivo) => {
    log('rejeição não tratada — encerrando', { erro: String(motivo) });
    void encerrar('unhandledRejection');
  });
}

main().catch((err) => {
  log('falha fatal na inicialização', { erro: (err as Error).message });
  process.exit(1);
});
