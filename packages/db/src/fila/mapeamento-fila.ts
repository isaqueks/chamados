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
  /** Contador interno do worker: reagendamentos por lock de tenant ocupado (D-016). */
  esperasLock?: number;
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

/**
 * Enfileira um mapeamento (best-effort — o chamador trata erros). Dedupe por
 * sistema: enquanto um job do mesmo sistema está pendente/rodando, o `add` é
 * ignorado pelo BullMQ. Um job ANTERIOR já encerrado (falhou — `removeOnFail:
 * false` o mantém para auditoria — ou concluído) ocuparia o mesmo `jobId` e
 * faria o BullMQ ignorar o pedido novo em silêncio (D-033); por isso ele é
 * removido antes de enfileirar de novo.
 */
export async function enfileirarMapeamento(job: JobMapeamento): Promise<void> {
  const q = filaMapeamento();
  const jobId = jobIdMapeamento(job.sistemaAlvoId);
  const anterior = await q.getJob(jobId);
  if (anterior) {
    const estado = await anterior.getState();
    if (estado === 'failed' || estado === 'completed') await anterior.remove();
  }
  await q.add(NOME_JOB_MAPEAMENTO, job, opcoesJobMapeamento(jobId));
}

/** Fecha a conexão da Queue (uso em scripts/smokes). */
export async function fecharFilaMapeamento(): Promise<void> {
  if (globalRef.__chamadosFilaMapeamento) {
    await globalRef.__chamadosFilaMapeamento.close();
    globalRef.__chamadosFilaMapeamento = undefined;
  }
}
