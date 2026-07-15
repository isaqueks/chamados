import { Queue, Worker, type Job } from 'bullmq';
import { executarManutencao, type DepsManutencao } from '../manutencao/processador';

/**
 * Registro MODULAR da fila `manutencao` (M10 — specs/04 §8.1). Mesmo padrão da
 * triagem/notificações, com uma diferença: além do Worker, agenda um JOB
 * REPETÍVEL (via job scheduler do BullMQ) que dispara a varredura de
 * auto-fechamento a cada `intervaloMs`. O `upsertJobScheduler` é idempotente —
 * reinícios do worker (ou múltiplas instâncias) reaproveitam o mesmo scheduler,
 * sem acumular agendamentos; e o lock global no processador garante que só uma
 * instância varre por vez.
 */

/** Nome canônico da fila. */
export const NOME_FILA_MANUTENCAO = 'manutencao';
/** Id do job scheduler (repetível) de auto-fechamento. */
export const SCHEDULER_AUTO_FECHAMENTO = 'auto-fechamento';
/** Nome do job disparado pelo scheduler. */
export const NOME_JOB_AUTO_FECHAMENTO = 'auto-fechamento';

export interface DepsRegistrarManutencao extends DepsManutencao {
  connection: { host: string; port: number };
  /** Intervalo entre varreduras (ms). Default no `index`: 5 min. */
  intervaloMs: number;
}

export async function registrarManutencao(deps: DepsRegistrarManutencao): Promise<Worker> {
  // Agenda o repetível (idempotente entre reinícios/instâncias).
  const queue = new Queue(NOME_FILA_MANUTENCAO, { connection: deps.connection });
  await queue.upsertJobScheduler(
    SCHEDULER_AUTO_FECHAMENTO,
    { every: deps.intervaloMs },
    { name: NOME_JOB_AUTO_FECHAMENTO, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await queue.close();

  const worker = new Worker(NOME_FILA_MANUTENCAO, async (_job: Job) => executarManutencao(deps), {
    connection: deps.connection,
    concurrency: 1,
  });

  worker.on('ready', () => deps.log('fila manutencao pronta', { intervaloMs: deps.intervaloMs }));
  worker.on('completed', (job, ret) =>
    deps.log('varredura de manutencao concluída', { jobId: job.id, resultado: ret }),
  );
  worker.on('failed', (job, err) =>
    deps.log('varredura de manutencao falhou (retry via BullMQ)', {
      jobId: job?.id,
      erro: err.message,
    }),
  );
  worker.on('error', (err) => deps.log('erro na fila manutencao', { erro: err.message }));

  return worker;
}

/** Lê a config da fila `manutencao` do ambiente (defaults de dev). */
export function manutencaoConfigEnv(): { intervaloMs: number; lockTtlMs: number } {
  const num = (nome: string, padrao: number): number => {
    const v = Number(process.env[nome]);
    return Number.isFinite(v) && v > 0 ? v : padrao;
  };
  return {
    // Varre a cada 5 min por padrão (specs/04 §8.1 — decurso de N dias por tenant).
    intervaloMs: num('MANUTENCAO_INTERVALO_MS', 300_000),
    // TTL do lock global: menor que o intervalo, maior que uma varredura típica.
    lockTtlMs: num('MANUTENCAO_LOCK_TTL_MS', 240_000),
  };
}
