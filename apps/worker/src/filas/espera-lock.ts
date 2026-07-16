import { DelayedError, type Job } from 'bullmq';

/**
 * "Recurso ocupado" NÃO é falha (D-016): quando o processador não consegue o
 * lock por tenant, o job é REAGENDADO via `moveToDelayed` + `DelayedError` — o
 * padrão do BullMQ para devolver um job à fila SEM consumir `attempts`. Antes
 * (attempts: 3, backoff exp. 5s) a janela de retry era de ~105s, matematicamente
 * incapaz de sobreviver a um lock órfão (15 min à época): o job caía em `failed`
 * permanente e o chamado encalhava (incidente de 2026-07-16).
 *
 * Guard-rail: após `MAX_ESPERAS_LOCK` reagendamentos o erro original segue em
 * frente (consome tentativa e, no esgotamento, cai na compensação de falha
 * final) — cobre um lock legitimamente preso por execuções longas em série.
 */

/** Mensagem canônica do erro de lock ocupado (lançada pelos processadores). */
export const ERRO_LOCK_TENANT = 'lock_tenant_indisponivel';

/** Máximo de reagendamentos por lock ocupado antes de deixar virar falha real. */
export const MAX_ESPERAS_LOCK = 20;

/** Campo de controle embutido no payload do job (contador de reagendamentos). */
export interface ComEsperasLock {
  esperasLock?: number;
}

/**
 * Reagenda o job por lock ocupado. LANÇA `DelayedError` quando reagendou (o
 * BullMQ entende e não conta falha); RETORNA sem lançar quando o guard-rail
 * estourou ou não há token — o chamador deve então relançar o erro original.
 */
export async function reagendarPorLockOcupado<T extends ComEsperasLock>(
  job: Job<T>,
  token: string | undefined,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const esperas = (job.data.esperasLock ?? 0) + 1;
  if (!token || esperas > MAX_ESPERAS_LOCK) {
    log('lock de tenant ocupado além do limite — a tentativa vai contar', {
      jobId: job.id,
      esperas,
    });
    return;
  }
  await job.updateData({ ...job.data, esperasLock: esperas });
  // 30–45s com jitter (anti-sincronização entre jobs esperando o mesmo tenant).
  const atrasoMs = 30_000 + Math.floor(Math.random() * 15_000);
  await job.moveToDelayed(Date.now() + atrasoMs, token);
  log('lock de tenant ocupado — job reagendado sem consumir tentativa', {
    jobId: job.id,
    esperas,
    atrasoMs,
  });
  throw new DelayedError();
}
