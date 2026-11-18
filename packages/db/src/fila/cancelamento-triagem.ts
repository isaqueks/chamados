/**
 * CANCELAMENTO da triagem em curso ao silenciar a IA (D-041, complementa D-024 —
 * specs/05 §2/§8). Vive em `@chamados/db` porque os DOIS lados usam o mesmo
 * contrato: o web (que silencia, via `DespachanteFila.flush` pós-commit) e o
 * worker (que observa o sinal durante a execução).
 *
 * O sinal é uma CHAVE Redis com TTL por chamado (UUID — nunca colide entre
 * tenants): `chamados:triagem:cancelar:<chamadoId>`. O worker a consulta por
 * POLLING curto (sem conexão pub/sub dedicada: mais simples e sobrevive a
 * reconexões — a chave fica lá até o TTL). O envio é best-effort: se o sinal se
 * perder, a rede de segurança é a releitura de `chamado.ia_silenciada` DENTRO da
 * Tx2 (com lock da linha), que impede qualquer efeito.
 *
 * Chave obsoleta não cancela triagem futura: o worker APAGA a chave ao iniciar
 * cada execução, antes da Tx1 (que relê a flag — silêncio já commitado faz o job
 * ser descartado ali). Qualquer chave vista depois disso foi gravada por um
 * silêncio posterior ao início.
 */

/** Prefixo canônico da chave de cancelamento (por chamado). */
export const PREFIXO_CHAVE_CANCELAMENTO_TRIAGEM = 'chamados:triagem:cancelar:';

/**
 * TTL da chave: maior que a execução legítima mais longa (o limiar de execução
 * órfã é 30 min — D-016/D-044). Passado isso, nenhuma execução daquele momento
 * pode estar viva; a chave expira sozinha.
 */
export const TTL_SINAL_CANCELAMENTO_MS = 60 * 60_000;

/** Motivo canônico gravado em `ExecucaoIA.erro` quando a triagem é cancelada pelo silêncio. */
export const MOTIVO_CANCELAMENTO_IA_SILENCIADA = 'ia_silenciada';

export function chaveCancelamentoTriagem(chamadoId: string): string {
  return `${PREFIXO_CHAVE_CANCELAMENTO_TRIAGEM}${chamadoId}`;
}

/** Subconjunto do ioredis usado pelo sinal (injetável em teste). */
export interface RedisSinalCancelamento {
  set(chave: string, valor: string, modo: 'PX', ttlMs: number): Promise<unknown>;
  exists(chave: string): Promise<number>;
  del(chave: string): Promise<number>;
}

/** Grava o sinal de cancelamento do chamado (valor = instante ISO, só diagnóstico). */
export async function sinalizarCancelamentoTriagem(
  redis: RedisSinalCancelamento,
  chamadoId: string,
  ttlMs: number = TTL_SINAL_CANCELAMENTO_MS,
): Promise<void> {
  await redis.set(chaveCancelamentoTriagem(chamadoId), new Date().toISOString(), 'PX', ttlMs);
}

/** Há sinal de cancelamento para o chamado? */
export async function cancelamentoSinalizado(
  redis: RedisSinalCancelamento,
  chamadoId: string,
): Promise<boolean> {
  return (await redis.exists(chaveCancelamentoTriagem(chamadoId))) > 0;
}

/** Apaga o sinal (o worker chama no início de cada execução). */
export async function limparSinalCancelamento(
  redis: RedisSinalCancelamento,
  chamadoId: string,
): Promise<void> {
  await redis.del(chaveCancelamentoTriagem(chamadoId));
}

/** Subconjunto da Queue do BullMQ usado para remover pendentes (injetável em teste). */
export interface FilaComJobs {
  getJobs(
    tipos: Array<'delayed' | 'wait' | 'paused' | 'prioritized'>,
  ): Promise<Array<{ id?: string | null; remove(): Promise<unknown> }>>;
}

/**
 * Remove da fila `triagem-ia` TODOS os jobs pendentes (delayed/wait/paused/
 * prioritized — debounce, reagendamento por lock, reprocessamento manual) cujo
 * jobId começa com `prefixo` (o `prefixoJobChamado` do chamado). O job ATIVO não
 * pode ser removido: é o sinal que o interrompe. Devolve quantos foram removidos.
 */
export async function removerTriagensPendentes(
  fila: FilaComJobs,
  prefixo: string,
): Promise<number> {
  const pendentes = await fila.getJobs(['delayed', 'wait', 'paused', 'prioritized']);
  let removidos = 0;
  for (const j of pendentes) {
    if (typeof j.id === 'string' && j.id.startsWith(prefixo)) {
      try {
        await j.remove();
        removidos++;
      } catch {
        /* corrida: o job saiu do estado pendente (virou ativo) — o sinal cobre */
      }
    }
  }
  return removidos;
}
