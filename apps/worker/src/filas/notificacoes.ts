import { Worker, type Job } from 'bullmq';
import { NOME_FILA_NOTIFICACOES, type JobFila } from '@chamados/db';
import { processarNotificacao, type DepsProcessador } from '../notificacoes/processador';

/**
 * Registro MODULAR da fila `notificacoes` (M9 — specs/06 §8). Mesmo padrão da
 * triagem: o `index` chama `registrarNotificacoes()`; toda a lógica de entrega
 * (idempotência, templates, adapters, circuito de falhas do webhook) vive no
 * processador. Concorrência mais alta que a triagem (entrega é barata).
 */
export interface DepsRegistrarNotificacoes extends DepsProcessador {
  connection: { host: string; port: number };
  concorrencia: number;
}

export function registrarNotificacoes(deps: DepsRegistrarNotificacoes): Worker<JobFila> {
  const worker = new Worker<JobFila>(
    NOME_FILA_NOTIFICACOES,
    async (job: Job<JobFila>) => processarNotificacao(job.data, deps),
    { connection: deps.connection, concurrency: deps.concorrencia },
  );

  worker.on('ready', () =>
    deps.log('fila notificacoes pronta', { concorrencia: deps.concorrencia }),
  );
  worker.on('completed', (job, ret) =>
    deps.log('job notificacao concluído', { jobId: job.id, resultado: ret }),
  );
  worker.on('failed', (job, err) =>
    deps.log('job notificacao falhou (retry via BullMQ)', { jobId: job?.id, erro: err.message }),
  );
  worker.on('error', (err) => deps.log('erro na fila notificacoes', { erro: err.message }));

  return worker;
}
