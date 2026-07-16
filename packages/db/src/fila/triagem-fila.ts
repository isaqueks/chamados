import { Queue, type JobsOptions } from 'bullmq';
import { GatilhoIA } from '@chamados/shared';
import type { Despachante, EventoDominio } from '../chamados/eventos-dominio';

/**
 * PUBLICADOR da fila `triagem-ia` (specs/01 §3.5, specs/05 §2). Vive em
 * `@chamados/db` porque é acessível TANTO ao web app (que enfileira ao criar
 * chamado / responder / reprocessar manualmente) QUANTO ao worker e ao smoke —
 * um único ponto de verdade para o nome da fila, o formato do job, o jobId
 * determinístico (dedupe) e o debounce. O CONSUMIDOR (processor) vive no worker
 * (`apps/worker/src/filas/triagem-ia.ts`), que importa o nome/tipo daqui.
 *
 * A dependência `bullmq` só instancia uma conexão Redis quando `filaTriagem()` é
 * chamada pela primeira vez (singleton preguiçoso, sobrevive ao HMR do Next) —
 * importar `@chamados/db` não abre conexão.
 */

/** Nome canônico da fila (specs/01 §3.5). */
export const NOME_FILA_TRIAGEM = 'triagem-ia';

/** Payload do job de triagem (specs/05 §2: chamado_id + ultima_mensagem_id). */
export interface JobTriagem {
  tenantId: string;
  chamadoId: string;
  /** `null` na abertura do chamado (ainda não há mensagem). */
  ultimaMensagemId: string | null;
  gatilho: GatilhoIA;
  /** Contador interno do worker: reagendamentos por lock de tenant ocupado (D-016). */
  esperasLock?: number;
}

/** Nome do job dentro da fila (BullMQ `name`). */
export const NOME_JOB_TRIAGEM = 'triagem';

/** Debounce (segundos) antes de processar a triagem — agrupa rajadas (specs/05 §2). */
export function debounceSegundos(): number {
  const v = Number(process.env.TRIAGEM_DEBOUNCE_S ?? '45');
  return Number.isFinite(v) && v >= 0 ? v : 45;
}

/** Conexão Redis (defaults batem com o docker-compose). */
function conexaoRedis(): { host: string; port: number } {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
  };
}

/**
 * jobId DETERMINÍSTICO por (chamado, última mensagem) — a chave de deduplicação
 * (specs/05 §2: "no máximo um job de triagem ativo por Chamado" para o mesmo
 * par). Dois enfileiramentos idênticos colapsam em um único job. Separador `__`
 * (o BullMQ proíbe `:` em jobId custom; UUIDs não contêm `__`).
 */
export function jobIdTriagem(chamadoId: string, ultimaMensagemId: string | null): string {
  return `${chamadoId}__${ultimaMensagemId ?? 'inicial'}`;
}

/** Prefixo do jobId de um chamado (para localizar/remover pendentes). */
export function prefixoJobChamado(chamadoId: string): string {
  return `${chamadoId}__`;
}

/** Opções padrão de resiliência (specs/05 §8: 3 tentativas, backoff exponencial). */
export function opcoesJobTriagem(delayMs: number, jobId: string): JobsOptions {
  return {
    jobId,
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false,
  };
}

// --- Singleton preguiçoso da Queue -----------------------------------------

const globalRef = globalThis as unknown as { __chamadosFilaTriagem?: Queue<JobTriagem> };

/** Retorna a Queue `triagem-ia` (cria na primeira chamada; sobrevive ao HMR). */
export function filaTriagem(): Queue<JobTriagem> {
  if (!globalRef.__chamadosFilaTriagem) {
    globalRef.__chamadosFilaTriagem = new Queue<JobTriagem>(NOME_FILA_TRIAGEM, {
      connection: conexaoRedis(),
    });
  }
  return globalRef.__chamadosFilaTriagem;
}

export interface OpcoesEnfileirar {
  /** Delay explícito (ms). Default: `debounceSegundos() * 1000`. */
  delayMs?: number;
  /**
   * Reprocessamento manual (specs/05 §2): jobId ÚNICO (não deduplica com o
   * automático) e sem substituir os pendentes. Default: `false`.
   */
  manual?: boolean;
}

/**
 * Enfileira uma triagem (best-effort — o chamador trata erros). Implementa o
 * DEBOUNCE substituível: um novo enfileiramento AUTOMÁTICO do mesmo chamado
 * remove os jobs pendentes (delayed/waiting) de mensagens anteriores, de modo
 * que a última mensagem "substitui" a triagem pendente (specs/05 §2). O
 * reprocessamento manual (`manual: true`) coexiste com jobId único.
 */
export async function enfileirarTriagem(
  job: JobTriagem,
  opts: OpcoesEnfileirar = {},
): Promise<void> {
  const q = filaTriagem();
  const delayMs = opts.delayMs ?? debounceSegundos() * 1000;

  const jobId = opts.manual
    ? `${job.chamadoId}__manual__${Date.now()}`
    : jobIdTriagem(job.chamadoId, job.ultimaMensagemId);

  if (!opts.manual) {
    // Substituível: remove pendentes do MESMO chamado com jobId diferente
    // (mensagens anteriores). O par idêntico é deduplicado pelo próprio jobId.
    const pendentes = await q.getJobs(['delayed', 'wait', 'paused', 'prioritized']);
    const prefixo = prefixoJobChamado(job.chamadoId);
    for (const j of pendentes) {
      if (typeof j.id === 'string' && j.id.startsWith(prefixo) && j.id !== jobId) {
        await j.remove().catch(() => {
          /* corrida: job já saiu do estado pendente — ignora */
        });
      }
    }
  }

  await q.add(
    NOME_JOB_TRIAGEM,
    job,
    opcoesJobTriagem(opts.manual ? (opts.delayMs ?? 0) : delayMs, jobId),
  );
}

/**
 * Despachante de eventos de domínio que ENFILEIRA a triagem-ia. Os eventos são
 * BUFFERIZADOS em `publicar` (síncrono, dentro da transação da mutação) e só vão
 * ao Redis em `flush()`, chamado PÓS-COMMIT pelo site de chamada — evitando job
 * fantasma se a transação der rollback. `flush` é best-effort: registra o erro e
 * segue (nunca quebra a mutação já commitada). Ver `despachanteNoop` para o
 * default sem efeitos.
 */
export class DespachanteFila implements Despachante {
  private readonly buffer: EventoDominio[] = [];

  constructor(
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  publicar(ev: EventoDominio): void {
    this.buffer.push(ev);
  }

  /** Enfileira os eventos bufferizados (best-effort). Chamar após o commit. */
  async flush(): Promise<void> {
    const pendentes = this.buffer.splice(0, this.buffer.length);
    for (const ev of pendentes) {
      if (ev.tipo !== 'triagem_solicitada') continue;
      try {
        await enfileirarTriagem({
          tenantId: ev.tenantId,
          chamadoId: ev.chamadoId,
          ultimaMensagemId: ev.ultimaMensagemId,
          gatilho: ev.gatilho,
        });
      } catch (err) {
        // Best-effort: falha de fila NUNCA quebra a mutação já commitada.
        this.log('falha ao enfileirar triagem (ignorado)', {
          chamadoId: ev.chamadoId,
          erro: (err as Error).message,
        });
      }
    }
  }

  /** Fecha a conexão da Queue (uso em scripts/smokes). */
  static async fechar(): Promise<void> {
    if (globalRef.__chamadosFilaTriagem) {
      await globalRef.__chamadosFilaTriagem.close();
      globalRef.__chamadosFilaTriagem = undefined;
    }
  }
}
