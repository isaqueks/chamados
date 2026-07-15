/**
 * Contrato do gateway plugável (specs/06 §2.1). O adapter só ENTREGA uma mensagem
 * já renderizada por um transporte específico — não conhece regra de negócio nem
 * implementa retry (isso é da fila). Ele apenas classifica o resultado:
 * `falha_temporaria` → a fila re-tenta; `falha_permanente` → descarta (DLQ).
 */

export type CanalTipo = 'email' | 'webhook';

/** Payload já renderizado, pronto para transporte. */
export interface NotificationPayload {
  canal: CanalTipo;
  /** e-mail do destinatário OU URL do webhook. */
  destino: string;
  // --- e-mail ---
  assunto?: string;
  corpoTexto?: string;
  corpoHtml?: string;
  // --- webhook ---
  corpoJson?: unknown;
  /** Header `X-Chamados-Event` (categoria do webhook). */
  webhookEvento?: string;
  /** Header `X-Chamados-Event-Id` (dedupe no receptor). */
  webhookEventoId?: string;
}

export interface EnvioResultado {
  status: 'entregue' | 'aceito' | 'falha_temporaria' | 'falha_permanente';
  /** message-id do provider (conciliação). */
  idExterno?: string;
  erro?: string;
}

/** Config resolvida do canal do tenant (segredos já decifrados). */
export interface CanalConfig {
  tenantId: string;
  tipo: CanalTipo;
  /** Credenciais/segredos já decifrados (SMTP host/port/... ou segredo HMAC). */
  segredos: Record<string, string>;
  /** Remetente ("Suporte ACME <no-reply@...>"), quando aplicável. */
  remetente?: string;
}

export interface NotificationGateway {
  readonly tipo: CanalTipo;
  /** Envia uma notificação já renderizada. NÃO implementa retry (specs/06 §2.1). */
  enviar(payload: NotificationPayload, config: CanalConfig): Promise<EnvioResultado>;
}
