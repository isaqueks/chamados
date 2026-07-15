import nodemailer, { type Transporter } from 'nodemailer';
import type {
  CanalConfig,
  EnvioResultado,
  NotificationGateway,
  NotificationPayload,
} from './tipos';

/**
 * Adapter de e-mail SMTP (specs/06 §3.1). Transporte via Nodemailer, compatível
 * com provedores transacionais (SES/Resend/Postmark/SMTP próprio). Em dev, aponta
 * para o Mailpit do docker-compose. O `Transporter` é INJETÁVEL para teste (o
 * smoke injeta um transporte fake que captura os e-mails sem rede).
 */
export interface OpcoesSmtp {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

/** Códigos SMTP definitivos (5xx de destinatário) → falha PERMANENTE (sem retry). */
function ehPermanente(erro: unknown): boolean {
  const e = erro as { responseCode?: number; code?: string };
  if (typeof e?.responseCode === 'number') {
    return [550, 551, 553, 554].includes(e.responseCode);
  }
  return false;
}

export class SmtpAdapter implements NotificationGateway {
  readonly tipo = 'email' as const;

  constructor(private readonly transporter: Transporter) {}

  /** Cria um adapter com transporte SMTP real a partir das opções (dev: Mailpit). */
  static real(opts: OpcoesSmtp): SmtpAdapter {
    return new SmtpAdapter(
      nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      }),
    );
  }

  async enviar(payload: NotificationPayload, config: CanalConfig): Promise<EnvioResultado> {
    try {
      const info = (await this.transporter.sendMail({
        from: config.remetente,
        to: payload.destino,
        subject: payload.assunto ?? '(sem assunto)',
        text: payload.corpoTexto,
        html: payload.corpoHtml,
      })) as { messageId?: string };
      return { status: 'entregue', idExterno: info?.messageId };
    } catch (err) {
      return {
        status: ehPermanente(err) ? 'falha_permanente' : 'falha_temporaria',
        erro: (err as Error).message,
      };
    }
  }
}
