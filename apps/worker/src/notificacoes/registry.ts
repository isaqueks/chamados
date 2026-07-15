import type { CanalTipo, NotificationGateway } from './tipos';
import { SmtpAdapter, type OpcoesSmtp } from './smtp-adapter';
import { WebhookAdapter } from './webhook-adapter';

/**
 * GatewayRegistry (specs/06 §2.1): map `CanalTipo → NotificationGateway`, populado
 * no boot do worker. Adicionar um canal (ex.: WhatsApp) é registrar mais um
 * adapter aqui — o núcleo de disparo não muda.
 */
export class GatewayRegistry {
  private readonly gateways = new Map<CanalTipo, NotificationGateway>();

  registrar(gateway: NotificationGateway): this {
    this.gateways.set(gateway.tipo, gateway);
    return this;
  }

  obter(tipo: CanalTipo): NotificationGateway | undefined {
    return this.gateways.get(tipo);
  }
}

/** Registry padrão de produção/dev: SMTP (Mailpit em dev) + Webhook. */
export function registryPadrao(opts: {
  smtp: OpcoesSmtp;
  webhookTimeoutMs: number;
}): GatewayRegistry {
  return new GatewayRegistry()
    .registrar(SmtpAdapter.real(opts.smtp))
    .registrar(new WebhookAdapter(opts.webhookTimeoutMs));
}
