import { escaparHtml, type EventoNotificavel, type PayloadWebhook } from '@chamados/db';

/**
 * Templates pt-BR com branding do tenant (specs/06 §5). Renderiza o e-mail
 * (assunto + HTML responsivo + fallback texto) e o payload do webhook (§3.2).
 * TODO conteúdo de usuário (título, autor, trecho) é ESCAPADO antes de entrar no
 * HTML (anti-XSS — specs/09). NUNCA inclui conteúdo interno (nota/complexidade).
 */

const ROTULO_STATUS: Record<string, string> = {
  novo: 'Novo',
  em_triagem: 'Em triagem',
  aguardando_cliente: 'Aguardando cliente',
  em_atendimento: 'Em atendimento',
  resolvido: 'Resolvido',
  fechado: 'Fechado',
  cancelado: 'Cancelado',
};

const ROTULO_PRIORIDADE: Record<string, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  urgente: 'Urgente',
};

function rotuloStatus(s: string | null | undefined): string {
  return (s && ROTULO_STATUS[s]) || s || '';
}
function rotuloPrioridade(p: string | null | undefined): string {
  return (p && ROTULO_PRIORIDADE[p]) || p || '';
}

/** Dados para renderizar um e-mail de evento de chamado. */
export interface DadosEmailChamado {
  tenantNome: string;
  corPrimaria: string;
  evento: EventoNotificavel;
  numero: string;
  titulo: string;
  status: string;
  prioridade: string;
  autorNome?: string | null;
  trechoPublico?: string | null;
  para?: string | null;
  link: string;
}

/** Linha de assunto + frase principal por evento (pt-BR). */
function frasePorEvento(d: DadosEmailChamado): { assunto: string; frase: string } {
  const ref = `#${d.numero}`;
  switch (d.evento) {
    case 'chamado_criado':
      return {
        assunto: `Recebemos seu chamado ${ref}`,
        frase: `Recebemos seu chamado ${ref} e ele já está na fila de atendimento.`,
      };
    case 'mensagem_publica':
      return {
        assunto: `Nova mensagem no chamado ${ref}`,
        frase: d.autorNome
          ? `${d.autorNome} respondeu ao chamado ${ref}.`
          : `Há uma nova mensagem no chamado ${ref}.`,
      };
    case 'mudanca_status':
      return {
        assunto: `Chamado ${ref}: status ${rotuloStatus(d.para ?? d.status)}`,
        frase: `O status do chamado ${ref} mudou para ${rotuloStatus(d.para ?? d.status)}.`,
      };
    case 'mudanca_prioridade':
      return {
        assunto: `Chamado ${ref}: prioridade ${rotuloPrioridade(d.para ?? d.prioridade)}`,
        frase: `A prioridade do chamado ${ref} mudou para ${rotuloPrioridade(d.para ?? d.prioridade)}.`,
      };
    case 'atribuicao':
      return {
        assunto: `Você é o responsável pelo chamado ${ref}`,
        frase: `O chamado ${ref} foi atribuído a você.`,
      };
    case 'resolvido':
      return {
        assunto: `Chamado ${ref} resolvido`,
        frase: `O chamado ${ref} foi marcado como resolvido. Se o problema persistir, você pode reabri-lo pelo portal.`,
      };
    case 'fechado':
      return { assunto: `Chamado ${ref} fechado`, frase: `O chamado ${ref} foi fechado.` };
    case 'reaberto':
      return {
        assunto: `Chamado ${ref} reaberto`,
        frase: `O chamado ${ref} voltou para atendimento.`,
      };
    case 'cancelado':
      return { assunto: `Chamado ${ref} cancelado`, frase: `O chamado ${ref} foi cancelado.` };
  }
}

/** Renderiza o e-mail (assunto + texto + HTML) com branding do tenant. */
export function montarEmailChamado(d: DadosEmailChamado): {
  assunto: string;
  texto: string;
  html: string;
} {
  const { assunto, frase } = frasePorEvento(d);
  const cor = /^#[0-9a-fA-F]{6}$/.test(d.corPrimaria) ? d.corPrimaria : '#2563eb';
  const tituloEsc = escaparHtml(d.titulo);
  const marca = escaparHtml(d.tenantNome);

  const trecho =
    d.evento === 'mensagem_publica' && d.trechoPublico
      ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid ${cor};background:#f8fafc;color:#334155;border-radius:4px;">${escaparHtml(
          d.trechoPublico,
        )}</blockquote>`
      : '';

  const texto = [
    `${marca}`,
    ``,
    frase,
    ``,
    `Chamado #${d.numero}: ${d.titulo}`,
    `Status: ${rotuloStatus(d.status)} · Prioridade: ${rotuloPrioridade(d.prioridade)}`,
    d.evento === 'mensagem_publica' && d.trechoPublico ? `\n"${d.trechoPublico}"\n` : ``,
    `Acesse: ${d.link}`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);">
        <tr><td style="background:${cor};padding:20px 28px;">
          <span style="color:#ffffff;font-size:16px;font-weight:600;">${marca}</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">${escaparHtml(frase)}</p>
          <p style="margin:0 0 4px;font-size:15px;font-weight:600;">Chamado #${d.numero}</p>
          <p style="margin:0 0 12px;font-size:15px;color:#334155;">${tituloEsc}</p>
          <p style="margin:0 0 16px;font-size:13px;color:#64748b;">Status: ${escaparHtml(
            rotuloStatus(d.status),
          )} &middot; Prioridade: ${escaparHtml(rotuloPrioridade(d.prioridade))}</p>
          ${trecho}
          <a href="${escaparHtml(d.link)}" style="display:inline-block;margin-top:8px;background:${cor};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px;">Ver chamado</a>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Você recebeu este e-mail porque acompanha chamados em ${marca}. Ajuste suas preferências de notificação no portal.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { assunto, texto, html };
}

/** Dados para o e-mail de alerta ao admin (webhook desativado). */
export interface DadosAlertaWebhook {
  tenantNome: string;
  corPrimaria: string;
  motivo: string;
  linkConfig: string;
}

export function montarEmailAlertaWebhook(d: DadosAlertaWebhook): {
  assunto: string;
  texto: string;
  html: string;
} {
  const cor = /^#[0-9a-fA-F]{6}$/.test(d.corPrimaria) ? d.corPrimaria : '#dc2626';
  const marca = escaparHtml(d.tenantNome);
  const assunto = `[Ação necessária] Webhook de notificações desativado`;
  const frase = `O webhook de notificações foi DESATIVADO automaticamente após falhas consecutivas de entrega. Nenhuma notificação está sendo enviada por webhook até a reativação manual.`;
  const texto = `${d.tenantNome}\n\n${frase}\n\nMotivo: ${d.motivo}\n\nCorrija o endpoint e reative em: ${d.linkConfig}`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);">
      <tr><td style="background:${cor};padding:20px 28px;"><span style="color:#fff;font-weight:600;">${marca} &middot; Alerta</span></td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">${escaparHtml(frase)}</p>
        <p style="margin:0 0 16px;font-size:13px;color:#64748b;">Motivo: ${escaparHtml(d.motivo)}</p>
        <a href="${escaparHtml(d.linkConfig)}" style="display:inline-block;background:${cor};color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px;font-size:14px;">Reativar webhook</a>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { assunto, texto, html };
}

/** Dados para o e-mail transacional (convite / reset de senha). */
export interface DadosEmailTransacional {
  tenantNome: string;
  corPrimaria: string;
  tipo: 'convite' | 'reset_senha';
  url: string;
}

export function montarEmailTransacional(d: DadosEmailTransacional): {
  assunto: string;
  texto: string;
  html: string;
} {
  const cor = /^#[0-9a-fA-F]{6}$/.test(d.corPrimaria) ? d.corPrimaria : '#2563eb';
  const marca = escaparHtml(d.tenantNome);
  const conteudo =
    d.tipo === 'convite'
      ? {
          assunto: `Você foi convidado para ${d.tenantNome}`,
          frase: `Você foi convidado para acessar o suporte de ${d.tenantNome}. Clique abaixo para criar sua senha e ativar o acesso.`,
          botao: 'Aceitar convite',
        }
      : {
          assunto: `Redefinição de senha — ${d.tenantNome}`,
          frase: `Recebemos um pedido para redefinir sua senha em ${d.tenantNome}. Se foi você, clique abaixo. O link expira em breve.`,
          botao: 'Redefinir senha',
        };
  const texto = `${d.tenantNome}\n\n${conteudo.frase}\n\n${conteudo.botao}: ${d.url}`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);">
      <tr><td style="background:${cor};padding:20px 28px;"><span style="color:#fff;font-weight:600;">${marca}</span></td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">${escaparHtml(conteudo.frase)}</p>
        <a href="${escaparHtml(d.url)}" style="display:inline-block;background:${cor};color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px;font-size:14px;">${conteudo.botao}</a>
        <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">Se o botão não funcionar, copie e cole: ${escaparHtml(d.url)}</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { assunto: conteudo.assunto, texto, html };
}

/** Monta o payload do webhook (specs/06 §3.2) — sem conteúdo interno. */
export interface DadosWebhook {
  webhookTipo: PayloadWebhook['evento']['tipo'];
  eventoId: string;
  eventoTs: string;
  chamado: PayloadWebhook['chamado'];
  autorNome?: string | null;
  trechoPublico?: string | null;
  de?: string | null;
  para?: string | null;
  link: string;
  incluiMensagem: boolean;
  incluiMudanca: boolean;
}

export function montarPayloadWebhook(d: DadosWebhook): PayloadWebhook {
  return {
    evento: { tipo: d.webhookTipo, id: d.eventoId, timestamp: d.eventoTs },
    chamado: d.chamado,
    autor: d.incluiMensagem && d.autorNome ? { nome: d.autorNome } : null,
    mensagem: d.incluiMensagem && d.trechoPublico ? { trecho: d.trechoPublico } : null,
    mudanca: d.incluiMudanca ? { de: d.de ?? null, para: d.para ?? null } : null,
    linkChamado: d.link,
  };
}
