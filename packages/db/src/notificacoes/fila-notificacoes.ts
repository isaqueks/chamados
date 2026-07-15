import { Queue, type JobsOptions } from 'bullmq';
import type { Despachante, EventoDominio } from '../chamados/eventos-dominio';
import type { JobFila, JobNotificacao } from './tipos';

/**
 * PUBLICADOR da fila `notificacoes` (specs/06 §8, specs/01 §3.5). Vive em
 * `@chamados/db` porque enfileira TANTO do web app (despacho pós-mutação, e-mails
 * transacionais) QUANTO do worker (alerta de webhook desativado). O CONSUMIDOR
 * (processador) vive no worker (`apps/worker/src/filas/notificacoes.ts`). Conexão
 * Redis preguiçosa (singleton que sobrevive ao HMR) — importar `@chamados/db` não
 * abre conexão.
 */

/** Nome canônico da fila. */
export const NOME_FILA_NOTIFICACOES = 'notificacoes';
/** Nome do job dentro da fila (BullMQ `name`). */
export const NOME_JOB_NOTIFICACAO = 'notificar';

function conexaoRedis(): { host: string; port: number } {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
  };
}

/**
 * Opções de resiliência (specs/06 §8.2): backoff EXPONENCIAL, máx. 5 tentativas.
 * `jobId = idempotencyKey` deduplica enfileiramentos concorrentes do mesmo
 * (evento × destinatário × canal).
 */
export function opcoesJobNotificacao(idempotencyKey: string): JobsOptions {
  return {
    jobId: idempotencyKey,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: false,
  };
}

const globalRef = globalThis as unknown as { __chamadosFilaNotificacoes?: Queue<JobFila> };

/** Retorna a Queue `notificacoes` (cria na primeira chamada; sobrevive ao HMR). */
export function filaNotificacoes(): Queue<JobFila> {
  if (!globalRef.__chamadosFilaNotificacoes) {
    globalRef.__chamadosFilaNotificacoes = new Queue<JobFila>(NOME_FILA_NOTIFICACOES, {
      connection: conexaoRedis(),
    });
  }
  return globalRef.__chamadosFilaNotificacoes;
}

/** Enfileira um job de notificação (best-effort no chamador). */
export async function enfileirarNotificacao(job: JobFila): Promise<void> {
  const q = filaNotificacoes();
  await q.add(NOME_JOB_NOTIFICACAO, job, opcoesJobNotificacao(job.idempotencyKey));
}

/**
 * Despachante de eventos de domínio que captura NOTIFICAÇÕES. Os jobs traduzidos
 * pelo dispatcher (no seam de auditoria) são BUFFERIZADOS em `publicar` (síncrono,
 * dentro da transação) e só vão ao Redis em `flush()`, chamado PÓS-COMMIT — evita
 * enviar notificação de uma mutação que sofreu rollback. `flush` é best-effort:
 * registra o erro e segue (nunca quebra a mutação já commitada). Ignora eventos
 * `triagem_solicitada` (são do despachante da fila de IA).
 */
export class DespachanteNotificacoes implements Despachante {
  /** Sinaliza ao auditor que este despachante quer a tradução de notificações. */
  readonly capturaNotificacoes = true;
  private readonly buffer: JobNotificacao[] = [];

  constructor(
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  publicar(ev: EventoDominio): void {
    if (ev.tipo === 'notificacao') this.buffer.push(ev.job);
  }

  /** Enfileira os jobs bufferizados (best-effort). Chamar após o commit. */
  async flush(): Promise<void> {
    const pendentes = this.buffer.splice(0, this.buffer.length);
    for (const job of pendentes) {
      try {
        await enfileirarNotificacao(job);
      } catch (err) {
        this.log('falha ao enfileirar notificação (ignorado)', {
          evento: job.evento,
          canal: job.canal,
          erro: (err as Error).message,
        });
      }
    }
  }

  /** Fecha a conexão da Queue (uso em scripts/smokes). */
  static async fechar(): Promise<void> {
    if (globalRef.__chamadosFilaNotificacoes) {
      await globalRef.__chamadosFilaNotificacoes.close();
      globalRef.__chamadosFilaNotificacoes = undefined;
    }
  }
}
