import { Queue, type JobsOptions } from 'bullmq';

/**
 * PUBLICADOR da fila `mapeamento-ia` (D-013 — "Mapear agora"). Fila PRÓPRIA e leve
 * (não a `triagem-ia`): o mapeamento é vinculado ao SISTEMA (não a um chamado), e
 * uma fila separada evita que um worker de triagem legado consuma um job cuja forma
 * não entende. Vive em `@chamados/db` porque o web app enfileira e o worker consome
 * — um único ponto de verdade para nome da fila, formato do job e jobId (dedupe).
 *
 * O CONSUMIDOR (processor) vive no worker (`apps/worker/src/filas/mapeamento-ia.ts`).
 */

/** Nome canônico da fila. */
export const NOME_FILA_MAPEAMENTO = 'mapeamento-ia';
/** Nome do job dentro da fila. */
export const NOME_JOB_MAPEAMENTO = 'mapeamento';

/** Payload do job de mapeamento (D-013): sistema-alvo a mapear. */
export interface JobMapeamento {
  tenantId: string;
  sistemaAlvoId: string;
}

/** Conexão Redis (defaults batem com o docker-compose). */
function conexaoRedis(): { host: string; port: number } {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
  };
}

/**
 * jobId DETERMINÍSTICO por sistema-alvo: dedupe de "Mapear agora" repetidos
 * enquanto um mapeamento do mesmo sistema está pendente/rodando.
 */
export function jobIdMapeamento(sistemaAlvoId: string): string {
  return `mapa__${sistemaAlvoId}`;
}

/** Opções de resiliência (1 tentativa extra — mapeamento é caro; não insistir muito). */
export function opcoesJobMapeamento(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: false,
  };
}

// --- Singleton preguiçoso da Queue -----------------------------------------

const globalRef = globalThis as unknown as { __chamadosFilaMapeamento?: Queue<JobMapeamento> };

/** Retorna a Queue `mapeamento-ia` (cria na primeira chamada; sobrevive ao HMR). */
export function filaMapeamento(): Queue<JobMapeamento> {
  if (!globalRef.__chamadosFilaMapeamento) {
    globalRef.__chamadosFilaMapeamento = new Queue<JobMapeamento>(NOME_FILA_MAPEAMENTO, {
      connection: conexaoRedis(),
    });
  }
  return globalRef.__chamadosFilaMapeamento;
}

/** Enfileira um mapeamento (best-effort — o chamador trata erros). Dedupe por sistema. */
export async function enfileirarMapeamento(job: JobMapeamento): Promise<void> {
  const q = filaMapeamento();
  await q.add(NOME_JOB_MAPEAMENTO, job, opcoesJobMapeamento(jobIdMapeamento(job.sistemaAlvoId)));
}

/** Fecha a conexão da Queue (uso em scripts/smokes). */
export async function fecharFilaMapeamento(): Promise<void> {
  if (globalRef.__chamadosFilaMapeamento) {
    await globalRef.__chamadosFilaMapeamento.close();
    globalRef.__chamadosFilaMapeamento = undefined;
  }
}
