/**
 * Esqueleto do worker BullMQ do Chamados (M0).
 *
 * - Conecta no Redis.
 * - Registra a fila "healthcheck" com um processor trivial.
 * - Enfileira um job de heartbeat na subida (prova ponta-a-ponta).
 * - Encerra de forma limpa em SIGTERM/SIGINT.
 *
 * Os workers reais (triagem de IA, notificações) virão em marcos seguintes.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { FILA_HEALTHCHECK, redisConnection } from './config';

function log(msg: string, extra?: Record<string, unknown>): void {
  const base = { ts: new Date().toISOString(), servico: 'worker', msg, ...extra };
  console.log(JSON.stringify(base));
}

async function main(): Promise<void> {
  log('iniciando worker', { redis: `${redisConnection.host}:${redisConnection.port}` });

  const fila = new Queue(FILA_HEALTHCHECK, { connection: redisConnection });

  const worker = new Worker(
    FILA_HEALTHCHECK,
    async (job: Job) => {
      log('processando job', { fila: FILA_HEALTHCHECK, jobId: job.id, nome: job.name });
      return { ok: true, processadoEm: new Date().toISOString() };
    },
    { connection: redisConnection },
  );

  worker.on('ready', () => log('worker pronto', { fila: FILA_HEALTHCHECK }));
  worker.on('completed', (job) => log('job concluído', { jobId: job.id }));
  worker.on('failed', (job, err) => log('job falhou', { jobId: job?.id, erro: err.message }));
  worker.on('error', (err) => log('erro do worker', { erro: err.message }));

  // Heartbeat inicial: prova que enfileirar + processar funcionam.
  await fila.add('heartbeat', { origem: 'startup' }, { removeOnComplete: true });
  log('job de heartbeat enfileirado');

  // ---- Encerramento limpo ------------------------------------------------
  let encerrando = false;
  const encerrar = async (sinal: string): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    log('encerrando', { sinal });
    try {
      await worker.close();
      await fila.close();
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
