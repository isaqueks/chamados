import { Worker, type Job } from 'bullmq';
import { NOME_FILA_TRIAGEM, type JobTriagem } from '@chamados/db';
import { processarTriagem, type DepsProcessador } from '../triagem/processador';

/**
 * Registro MODULAR da fila `triagem-ia` (specs/01 §3.5). O `index` chama
 * `registrarTriagemIA()` — o mesmo padrão que o M9 usará para
 * `src/filas/notificacoes.ts` (outro `registrar()`), sem tocar nesta lógica.
 *
 * Concorrência GLOBAL baixa (a triagem é cara) + lock por tenant DENTRO do
 * processador (`processarTriagem`) garantem 1 execução simultânea por tenant
 * (specs/05 §2).
 */
export interface DepsRegistrar extends DepsProcessador {
  connection: { host: string; port: number };
  concorrencia: number;
}

export function registrarTriagemIA(deps: DepsRegistrar): Worker<JobTriagem> {
  const worker = new Worker<JobTriagem>(
    NOME_FILA_TRIAGEM,
    async (job: Job<JobTriagem>) => processarTriagem(job.data, deps),
    { connection: deps.connection, concurrency: deps.concorrencia },
  );

  worker.on('ready', () => deps.log('fila triagem-ia pronta', { concorrencia: deps.concorrencia }));
  worker.on('completed', (job, ret) =>
    deps.log('job triagem concluído', { jobId: job.id, resultado: ret }),
  );
  worker.on('failed', (job, err) =>
    deps.log('job triagem falhou (retry via BullMQ)', { jobId: job?.id, erro: err.message }),
  );
  worker.on('error', (err) => deps.log('erro na fila triagem-ia', { erro: err.message }));

  return worker;
}
