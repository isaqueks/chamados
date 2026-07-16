import { Worker, type Job } from 'bullmq';
import {
  NOME_FILA_TRIAGEM,
  runInTenantContext,
  criarExecucao,
  falharExecucao,
  type JobTriagem,
} from '@chamados/db';
import { processarTriagem, type DepsProcessador } from '../triagem/processador';
import { escalarParaHumano } from '../triagem/aplicador';
import { ERRO_LOCK_TENANT, reagendarPorLockOcupado } from './espera-lock';

/**
 * Registro MODULAR da fila `triagem-ia` (specs/01 §3.5). O `index` chama
 * `registrarTriagemIA()` — o mesmo padrão que o M9 usará para
 * `src/filas/notificacoes.ts` (outro `registrar()`), sem tocar nesta lógica.
 *
 * Concorrência GLOBAL baixa (a triagem é cara) + lock por tenant DENTRO do
 * processador (`processarTriagem`) garantem 1 execução simultânea por tenant
 * (specs/05 §2). Lock ocupado NÃO consome tentativa (reagendamento via
 * `DelayedError` — D-016); o esgotamento REAL das tentativas dispara a
 * compensação (`ExecucaoIA.falhou` + escalonamento — specs/05 §8).
 */
export interface DepsRegistrar extends DepsProcessador {
  connection: { host: string; port: number };
  concorrencia: number;
}

export function registrarTriagemIA(deps: DepsRegistrar): Worker<JobTriagem> {
  const worker = new Worker<JobTriagem>(
    NOME_FILA_TRIAGEM,
    async (job: Job<JobTriagem>, token?: string) => {
      try {
        return await processarTriagem(job.data, deps);
      } catch (err) {
        if (err instanceof Error && err.message === ERRO_LOCK_TENANT) {
          // Lança DelayedError quando reagendou; senão cai no throw abaixo.
          await reagendarPorLockOcupado(job, token, deps.log);
        }
        throw err;
      }
    },
    { connection: deps.connection, concurrency: deps.concorrencia },
  );

  worker.on('ready', () => deps.log('fila triagem-ia pronta', { concorrencia: deps.concorrencia }));
  worker.on('completed', (job, ret) =>
    deps.log('job triagem concluído', { jobId: job.id, resultado: ret }),
  );
  worker.on('failed', (job, err) => {
    const final = job != null && job.attemptsMade >= (job.opts.attempts ?? 1);
    deps.log(
      final
        ? 'job triagem falhou DEFINITIVAMENTE — compensando e escalando para humano'
        : 'job triagem falhou (retry via BullMQ)',
      { jobId: job?.id, tentativas: job?.attemptsMade, erro: err.message },
    );
    if (final && job) void compensarFalhaFinal(job.data, err.message, deps);
  });
  worker.on('error', (err) => deps.log('erro na fila triagem-ia', { erro: err.message }));

  return worker;
}

/**
 * Compensação da falha FINAL no nível da FILA (specs/05 §8: "o chamado nunca
 * fica preso sem responsável"). Só chega aqui erro que ESCAPOU do processador
 * (lock além do limite, banco indisponível na Tx1…) — nesses casos não existe
 * `ExecucaoIA` nem escalonamento (o tratamento interno do pipeline pressupõe a
 * Tx1). Cria a `ExecucaoIA` já `falhou` (auditoria) e escala o chamado a um
 * humano. Best-effort: falha da própria compensação é logada (a varredura de
 * manutenção é a rede de segurança final) e nunca derruba o worker.
 */
export async function compensarFalhaFinal(
  job: JobTriagem,
  erro: string,
  deps: Pick<DepsProcessador, 'ds' | 'provider' | 'log'>,
): Promise<void> {
  try {
    await runInTenantContext(deps.ds, job.tenantId, async (em) => {
      const execucaoId = await criarExecucao(
        em,
        { tenant_id: job.tenantId },
        {
          chamado_id: job.chamadoId,
          gatilho: job.gatilho,
          provider: deps.provider.nome,
          modelo: deps.provider.modelo,
          entrada: {
            ultima_mensagem_id: job.ultimaMensagemId,
            gatilho: job.gatilho,
            compensacao: 'falha_final_fila',
          },
        },
      );
      await falharExecucao(em, execucaoId, erro);
      await escalarParaHumano(
        em,
        { tenantId: job.tenantId, chamadoId: job.chamadoId, execucaoId, erro },
        { log: deps.log },
      );
    });
  } catch (e) {
    deps.log('compensação da falha final falhou — chamado pode exigir ação manual', {
      chamadoId: job.chamadoId,
      erro: (e as Error).message,
    });
  }
}
