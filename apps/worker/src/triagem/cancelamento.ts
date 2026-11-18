import {
  cancelamentoSinalizado,
  limparSinalCancelamento,
  type RedisSinalCancelamento,
} from '@chamados/db';
import { ErroTriagemCancelada } from '../ia/erros';

/**
 * OBSERVADOR do cancelamento da triagem em curso (D-041, specs/05 §2/§8). Quando
 * a IA é silenciada no chamado, o web grava (pós-commit) a chave Redis
 * `chamados:triagem:cancelar:<chamadoId>`; a execução viva a consulta por POLLING
 * curto e, ao vê-la, aborta o `AbortSignal` entregue ao provider — o MESMO
 * mecanismo de abort do timeout no `ClaudeAgentProvider` (mata o subprocesso do
 * SDK). As etapas sem abort próprio (git sync, mapeamento inline, resolução)
 * consultam `verificarAgora()` nos pontos de checagem.
 *
 * Polling, não pub/sub: sem conexão de assinatura dedicada, sem mensagem perdida
 * em reconexão (a chave persiste até o TTL). O custo é um `EXISTS` a cada poucos
 * segundos por execução viva — desprezível (o lock por tenant já renova a cada
 * 30 s). Falha de Redis no polling é ignorada (best-effort): a rede de segurança
 * é a releitura de `chamado.ia_silenciada` na Tx2.
 */

/** Intervalo padrão do polling (ms). */
export const INTERVALO_POLL_CANCELAMENTO_MS = 2_000;

/**
 * Teto de espera por resposta do Redis (ms). O cliente do worker usa
 * `maxRetriesPerRequest: null` (exigência do BullMQ): com o Redis fora, um
 * comando NÃO falha — fica pendente. Sem este teto, cada ponto de checagem
 * travaria a triagem até o Redis voltar; com ele, o estouro vale "sem sinal" e
 * a rede de segurança continua sendo a releitura de `ia_silenciada` na Tx2.
 */
export const TIMEOUT_REDIS_CANCELAMENTO_MS = 1_500;

function comTeto<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis_sem_resposta')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface ObservadorCancelamento {
  /** Abortado quando o cancelamento é detectado (motivo: `ErroTriagemCancelada`). */
  readonly signal: AbortSignal;
  /** Já detectou o cancelamento? (sem I/O) */
  cancelado(): boolean;
  /** Consulta o Redis AGORA (pontos de checagem); aborta o signal se houver sinal. */
  verificarAgora(): Promise<boolean>;
  /** Para o polling (sempre chamar no `finally`). */
  parar(): void;
}

export function observarCancelamento(
  redis: RedisSinalCancelamento,
  chamadoId: string,
  opts: {
    intervaloMs?: number;
    /** Teto de espera pelo Redis em cada consulta (default `TIMEOUT_REDIS_CANCELAMENTO_MS`). */
    timeoutRedisMs?: number;
    /**
     * Confirma no BANCO que o chamado está mesmo silenciado. O sinal Redis é
     * gravado pós-commit, sem ordenação: um sinal ATRASADO (silenciar → reativar →
     * nova triagem → o flush antigo chega) não pode cancelar uma triagem
     * legítima. Com `confirmar`, sinal sem flag é obsoleto: é apagado e ignorado.
     * Ausente → o sinal sozinho basta (comportamento dos testes de unidade).
     */
    confirmar?: () => Promise<boolean>;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
  } = {},
): ObservadorCancelamento {
  const controller = new AbortController();
  const log = opts.log ?? (() => {});
  const tetoMs = opts.timeoutRedisMs ?? TIMEOUT_REDIS_CANCELAMENTO_MS;
  let emVoo = false;
  let parado = false;

  const verificarAgora = async (): Promise<boolean> => {
    if (controller.signal.aborted) return true;
    try {
      if (await comTeto(cancelamentoSinalizado(redis, chamadoId), tetoMs)) {
        if (opts.confirmar && !(await opts.confirmar())) {
          log('triagem: sinal de cancelamento obsoleto (IA não está silenciada) — ignorado', {
            chamadoId,
          });
          await comTeto(limparSinalCancelamento(redis, chamadoId), tetoMs).catch(() => {});
          return false;
        }
        if (!controller.signal.aborted) {
          log('triagem: cancelamento detectado (IA silenciada) — abortando', { chamadoId });
          controller.abort(new ErroTriagemCancelada());
        }
        return true;
      }
    } catch (err) {
      log('triagem: falha ao consultar sinal de cancelamento (ignorado)', {
        chamadoId,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  };

  const timer = setInterval(() => {
    if (emVoo || parado || controller.signal.aborted) return;
    emVoo = true;
    void verificarAgora().finally(() => {
      emVoo = false;
    });
  }, opts.intervaloMs ?? INTERVALO_POLL_CANCELAMENTO_MS);
  timer.unref?.();

  return {
    signal: controller.signal,
    cancelado: () => controller.signal.aborted,
    verificarAgora,
    parar: () => {
      parado = true;
      clearInterval(timer);
    },
  };
}

/**
 * Apaga um sinal OBSOLETO no início da execução (antes da Tx1, com o lock do
 * tenant já tomado). Seguro: se o silêncio já foi commitado, a Tx1 relê a flag e
 * descarta o job; qualquer chave gravada depois deste ponto é de um silêncio
 * posterior ao início. Best-effort (Redis fora → segue; a Tx2 é a rede).
 */
export async function descartarSinalObsoleto(
  redis: RedisSinalCancelamento,
  chamadoId: string,
): Promise<void> {
  await comTeto(limparSinalCancelamento(redis, chamadoId), TIMEOUT_REDIS_CANCELAMENTO_MS).catch(
    () => {},
  );
}
