import { assinarWebhook } from '@chamados/db';
import type {
  CanalConfig,
  EnvioResultado,
  NotificationGateway,
  NotificationPayload,
} from './tipos';

/**
 * Adapter de Webhook genérico (specs/06 §3.2, D-003). POST JSON assinado com
 * HMAC SHA-256 (`X-Chamados-Signature: sha256=<hex>`), header de evento e id do
 * evento (dedupe no receptor). Timeout CURTO por requisição (o worker impõe o
 * limite via AbortController); 2xx = aceito. NÃO implementa retry (é da fila): só
 * classifica (`falha_temporaria` para 5xx/timeout/rede; `falha_permanente` para
 * 4xx de cliente, exceto 408/429).
 */
export class WebhookAdapter implements NotificationGateway {
  readonly tipo = 'webhook' as const;

  constructor(private readonly timeoutMs: number = 5000) {}

  async enviar(payload: NotificationPayload, config: CanalConfig): Promise<EnvioResultado> {
    const url = payload.destino;
    const segredo = config.segredos.segredo ?? '';
    const corpo = JSON.stringify(payload.corpoJson ?? {});

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chamados-signature': assinarWebhook(segredo, corpo),
          'x-chamados-event': payload.webhookEvento ?? '',
          'x-chamados-event-id': payload.webhookEventoId ?? '',
        },
        body: corpo,
        signal: ctrl.signal,
      });
      if (resp.status >= 200 && resp.status < 300) {
        return { status: 'aceito' };
      }
      // 4xx (exceto 408/429) = configuração/endpoint errado → permanente.
      const permanente =
        resp.status >= 400 && resp.status < 500 && ![408, 429].includes(resp.status);
      return {
        status: permanente ? 'falha_permanente' : 'falha_temporaria',
        erro: `HTTP ${resp.status}`,
      };
    } catch (err) {
      // Abort (timeout) / erro de rede → temporário.
      return { status: 'falha_temporaria', erro: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
