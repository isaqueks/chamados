import { Worker, type Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { AIProvider } from '@chamados/shared';
import { NOME_FILA_MAPEAMENTO, runInTenantContext, type JobMapeamento } from '@chamados/db';
import { resolverConfigFerramentas } from '../triagem/ferramentas';
import { sincronizarRepo } from '../triagem/ferramentas/repo';
import { executarMapeamento, type MapaLimites } from '../mapeamento/mapeamento';
import { motivoErro } from '../ia/erros';
import { adquirirLockComEspera, liberarLockTenant, type OpcoesEspera } from '../lock-tenant';

/**
 * Consumidor da fila `mapeamento-ia` (D-013 — "Mapear agora"). Sincroniza o repo do
 * sistema-alvo e roda o mapeamento como `ExecucaoIA` dedicada. Adquire o MESMO lock
 * por tenant da triagem (1 execução de IA simultânea por tenant — evita mapa e
 * triagem competindo por budget). Fila PRÓPRIA: um worker de triagem legado não
 * consome estes jobs.
 */

export interface DepsMapeamentoJob {
  ds: DataSource;
  redis: Redis;
  provider: AIProvider;
  limites: MapaLimites;
  lock: OpcoesEspera;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export type ResultadoMapeamentoJob =
  | { status: 'concluido' }
  | { status: 'ignorado'; motivo: 'sem_repo' }
  | { status: 'falhou'; erro: string };

export async function processarMapeamentoJob(
  job: JobMapeamento,
  deps: DepsMapeamentoJob,
): Promise<ResultadoMapeamentoJob> {
  const { ds, redis, provider, limites, lock, log } = deps;

  const token = await adquirirLockComEspera(redis, job.tenantId, lock);
  if (!token) throw new Error('lock_tenant_indisponivel');

  try {
    const cfg = await runInTenantContext(ds, job.tenantId, (em) =>
      resolverConfigFerramentas(em, job.tenantId, job.sistemaAlvoId),
    );
    if (!cfg.repo) {
      log('mapeamento: sistema-alvo sem repositório configurado — ignorado', {
        sistemaAlvoId: job.sistemaAlvoId,
      });
      return { status: 'ignorado', motivo: 'sem_repo' };
    }
    const checkoutDir = await sincronizarRepo(cfg.repo);
    await executarMapeamento({
      ds,
      tenantId: job.tenantId,
      sistemaAlvoId: job.sistemaAlvoId,
      checkoutDir,
      provider,
      limites,
      log,
    });
    return { status: 'concluido' };
  } catch (err) {
    const erro = motivoErro(err);
    log('mapeamento (job) falhou', { sistemaAlvoId: job.sistemaAlvoId, erro });
    return { status: 'falhou', erro };
  } finally {
    await liberarLockTenant(redis, job.tenantId, token).catch(() => {});
  }
}

export interface DepsRegistrarMapeamento extends DepsMapeamentoJob {
  connection: { host: string; port: number };
  concorrencia: number;
}

export function registrarMapeamentoIA(deps: DepsRegistrarMapeamento): Worker<JobMapeamento> {
  const worker = new Worker<JobMapeamento>(
    NOME_FILA_MAPEAMENTO,
    async (job: Job<JobMapeamento>) => processarMapeamentoJob(job.data, deps),
    { connection: deps.connection, concurrency: deps.concorrencia },
  );
  worker.on('ready', () => deps.log('fila mapeamento-ia pronta'));
  worker.on('failed', (job, err) =>
    deps.log('job mapeamento falhou (retry via BullMQ)', { jobId: job?.id, erro: err.message }),
  );
  worker.on('error', (err) => deps.log('erro na fila mapeamento-ia', { erro: err.message }));
  return worker;
}
