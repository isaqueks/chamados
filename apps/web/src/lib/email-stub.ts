import 'server-only';

/**
 * Stub de envio de e-mail (specs/03): o envio real (SMTP/webhook) é o M9. Até lá,
 * registramos a "entrega" como log estruturado com a URL de ação (convite/reset),
 * para o fluxo ser testável em dev.
 */
export function logarEmailStub(dados: {
  tipo: 'convite' | 'reset_senha';
  destinatario: string;
  url: string;
}): void {
  console.info(
    JSON.stringify({
      evt: 'email_stub',
      ...dados,
      ts: new Date().toISOString(),
    }),
  );
}
