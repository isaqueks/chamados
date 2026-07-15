import 'server-only';
import {
  enfileirarNotificacao,
  chaveIdempotenciaTransacional,
  type JobTransacional,
} from '@chamados/db';

/**
 * Envio de e-mail TRANSACIONAL (convite / reset de senha — specs/03). Substitui o
 * antigo `email-stub` (M9): o e-mail real é ENFILEIRADO na fila `notificacoes`
 * (mesma infra de idempotência/retry) e o worker o entrega pelo SMTP da plataforma
 * (dev: Mailpit). Mantém um log dev-friendly com a URL de ação, para o fluxo
 * continuar inspecionável no terminal. Best-effort: uma fila indisponível não
 * quebra o fluxo de convite/reset (a resposta anti-enumeração é preservada).
 */
export async function enviarEmailTransacional(dados: {
  tipo: 'convite' | 'reset_senha';
  tenantId: string;
  destinatario: string;
  nome?: string | null;
  url: string;
}): Promise<void> {
  const job: JobTransacional = {
    especie: 'transacional',
    idempotencyKey: chaveIdempotenciaTransacional(dados.tipo, dados.url),
    tenantId: dados.tenantId,
    canal: 'email',
    tipo: dados.tipo,
    destinatarioEmail: dados.destinatario,
    destinatarioNome: dados.nome ?? null,
    url: dados.url,
  };

  try {
    await enfileirarNotificacao(job);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'email_transacional_falha',
        tipo: dados.tipo,
        erro: (err as Error).message,
      }),
    );
  }

  // Log de auditoria. A URL de ação CARREGA UM TOKEN DE USO ÚNICO (reset/convite):
  // logá-la em produção equivaleria a gravar credencial em log (specs/09 §7 e §8.6
  // — "logs não contêm segredos"). Fora de produção, mantemos a URL visível no
  // terminal para inspeção do fluxo (dev-friendly); em produção, é omitida.
  const ehProd = process.env.NODE_ENV === 'production';
  console.info(
    JSON.stringify({
      evt: 'email_transacional',
      tipo: dados.tipo,
      destinatario: dados.destinatario,
      ...(ehProd ? {} : { url: dados.url }),
      ts: new Date().toISOString(),
    }),
  );
}
