import { escaparHtml, type EventoNotificavel, type PayloadWebhook } from '@chamados/db';
import {
  FAIXAS_ESTIMATIVA_CUSTO,
  ehEstimativaCusto,
  faixaEstimativaCusto,
  formatarBrl,
  rotuloEstimativaCusto,
} from '@chamados/shared';
import {
  botao,
  dataEmissao,
  destaque,
  divisoria,
  documento,
  logoInline,
  negrito,
  rodapeTexto,
  secao,
  type ImagemInline,
} from './email-layout';

/**
 * Templates pt-BR (specs/06 §5). Renderiza o e-mail (assunto + HTML responsivo +
 * fallback texto + logo inline) no layout único da plataforma (D-047, ver
 * `email-layout.ts`) e o payload do webhook (§3.2).
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
  /** Nome do tenant — só na nota de rodapé ("acompanha chamados em …"). */
  tenantNome: string;
  /** Data de emissão impressa no cabeçalho (padrão: agora). */
  emitidoEm?: Date;
  evento: EventoNotificavel;
  numero: string;
  titulo: string;
  status: string;
  prioridade: string;
  autorNome?: string | null;
  trechoPublico?: string | null;
  para?: string | null;
  link: string;
  /**
   * O destinatário é o CLIENTE (portal)? Muda a pessoa do texto nos eventos da
   * janela de aprovação (D-042): "você tem até…" × "o cliente tem até…".
   */
  paraCliente?: boolean;
  /** D-042: prazo para aprovar/contestar, já formatado (evento `resolvido`). */
  prazoAprovacao?: string | null;
  /** D-042: forma da aprovação (evento `aprovado`). */
  aprovacao?: 'explicita' | 'tacita' | null;
  /** D-043: código da estimativa de custo atual (público) — `null` = sem estimativa. */
  estimativaCusto?: string | null;
  /** D-043: custo final atual em BRL (público) — `null` = não informado. */
  custoFinal?: number | null;
}

/** Rótulo da estimativa (D-043) ou `null` para código ausente/desconhecido. */
function rotuloEstimativa(codigo: string | null | undefined): string | null {
  return ehEstimativaCusto(codigo) ? rotuloEstimativaCusto(codigo) : null;
}

/** Linha de custo (D-043) para o corpo do e-mail — `null` quando não há nada a mostrar. */
function linhaCusto(d: DadosEmailChamado): string | null {
  const partes: string[] = [];
  const est = rotuloEstimativa(d.estimativaCusto);
  if (est) partes.push(`Estimativa de custo: ${est}`);
  if (typeof d.custoFinal === 'number') partes.push(`Custo final: ${formatarBrl(d.custoFinal)}`);
  return partes.length > 0 ? partes.join(' · ') : null;
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
    case 'resolvido': {
      // D-042: a resolução abre a janela de aprovação — o texto informa o prazo
      // e que o silêncio vale como aprovação.
      const ate = d.prazoAprovacao ? `até ${d.prazoAprovacao}` : 'um prazo';
      // D-043: o custo final (quando informado) acompanha o pedido de aprovação.
      const custo =
        typeof d.custoFinal === 'number' ? ` Custo final: ${formatarBrl(d.custoFinal)}.` : '';
      return d.paraCliente === false
        ? {
            assunto: `Chamado ${ref} resolvido`,
            frase: `O chamado ${ref} foi marcado como resolvido.${custo} O cliente tem ${ate} para aprovar ou contestar a solução; sem resposta, o chamado será considerado aprovado.`,
          }
        : {
            assunto: `Chamado ${ref} resolvido — aprove ou conteste`,
            frase: `O chamado ${ref} foi marcado como resolvido.${custo} Você tem ${ate} para aprovar ou contestar a solução pelo portal. Sem resposta até lá, o chamado será considerado aprovado e encerrado.`,
          };
    }
    case 'fechado':
      return { assunto: `Chamado ${ref} fechado`, frase: `O chamado ${ref} foi fechado.` };
    case 'aprovado':
      if (d.aprovacao === 'tacita') {
        return d.paraCliente === false
          ? {
              assunto: `Chamado ${ref} aprovado (sem resposta no prazo)`,
              frase: `O cliente não respondeu dentro do prazo e o chamado ${ref} foi considerado aprovado e encerrado.`,
            }
          : {
              assunto: `Chamado ${ref} considerado aprovado`,
              frase: `O prazo para aprovar ou contestar a solução do chamado ${ref} terminou sem resposta, então ele foi considerado aprovado e encerrado. Se o problema voltar, você pode reabri-lo pelo portal.`,
            };
      }
      return d.paraCliente === false
        ? {
            assunto: `Chamado ${ref} aprovado pelo cliente`,
            frase: d.autorNome
              ? `${d.autorNome} aprovou a solução do chamado ${ref}. O chamado foi encerrado.`
              : `O cliente aprovou a solução do chamado ${ref}. O chamado foi encerrado.`,
          }
        : {
            assunto: `Chamado ${ref} aprovado`,
            frase: `A solução do chamado ${ref} foi aprovada e o chamado foi encerrado.`,
          };
    case 'contestado':
      return {
        assunto: `Chamado ${ref}: solução contestada`,
        frase: d.autorNome
          ? `${d.autorNome} contestou a solução do chamado ${ref}, que voltou para atendimento.`
          : `O cliente contestou a solução do chamado ${ref}, que voltou para atendimento.`,
      };
    case 'reaberto':
      return {
        assunto: `Chamado ${ref} reaberto`,
        frase: `O chamado ${ref} voltou para atendimento.`,
      };
    case 'cancelado':
      return { assunto: `Chamado ${ref} cancelado`, frase: `O chamado ${ref} foi cancelado.` };
    case 'estimativa_custo': {
      const est = rotuloEstimativa(d.para ?? d.estimativaCusto);
      return est
        ? {
            assunto: `Chamado ${ref}: estimativa de custo ${est}`,
            frase: `A estimativa de custo do chamado ${ref} foi definida como ${est}.`,
          }
        : {
            assunto: `Chamado ${ref}: estimativa de custo removida`,
            frase: `A estimativa de custo do chamado ${ref} foi removida.`,
          };
    }
    case 'custo_final': {
      const valor = typeof d.custoFinal === 'number' ? formatarBrl(d.custoFinal) : null;
      return valor
        ? {
            assunto: `Chamado ${ref}: custo final ${valor}`,
            frase: `O custo final do chamado ${ref} foi informado: ${valor}.`,
          }
        : {
            assunto: `Chamado ${ref}: custo final removido`,
            frase: `O custo final do chamado ${ref} foi removido.`,
          };
    }
  }
}

/** E-mail renderizado: assunto + texto/plain + HTML + imagens inline (logo). */
export interface EmailRenderizado {
  assunto: string;
  texto: string;
  html: string;
  imagensInline: ImagemInline[];
}

/** Título do documento (o "Cobrança de Serviços" do layout — D-047) por evento. */
function tituloPorEvento(d: DadosEmailChamado): string {
  switch (d.evento) {
    case 'chamado_criado':
      return 'Chamado recebido';
    case 'mensagem_publica':
      return 'Nova mensagem';
    case 'mudanca_status':
      return 'Status atualizado';
    case 'mudanca_prioridade':
      return 'Prioridade alterada';
    case 'atribuicao':
      return 'Chamado atribuído';
    case 'resolvido':
      return 'Chamado resolvido';
    case 'fechado':
      return 'Chamado fechado';
    case 'aprovado':
      return 'Solução aprovada';
    case 'contestado':
      return 'Solução contestada';
    case 'reaberto':
      return 'Chamado reaberto';
    case 'cancelado':
      return 'Chamado cancelado';
    case 'estimativa_custo':
      return 'Estimativa de custo';
    case 'custo_final':
      return 'Custo final';
  }
}

/** Linhas de destaque (estilo "Total") por evento — texto puro, escapado depois. */
function destaquePorEvento(d: DadosEmailChamado): Array<{ rotulo: string; valor: string }> {
  const custo = typeof d.custoFinal === 'number' ? formatarBrl(d.custoFinal) : null;
  switch (d.evento) {
    case 'mensagem_publica':
    case 'contestado':
      return []; // a mensagem/o motivo já é o destaque
    case 'mudanca_status':
      return [{ rotulo: 'Novo status', valor: rotuloStatus(d.para ?? d.status) }];
    case 'mudanca_prioridade':
      return [{ rotulo: 'Nova prioridade', valor: rotuloPrioridade(d.para ?? d.prioridade) }];
    case 'resolvido': {
      const linhas: Array<{ rotulo: string; valor: string }> = [];
      if (custo) linhas.push({ rotulo: 'Custo final', valor: custo });
      if (d.prazoAprovacao) linhas.push({ rotulo: 'Prazo para aprovar', valor: d.prazoAprovacao });
      return linhas.length > 0 ? linhas : [{ rotulo: 'Status', valor: rotuloStatus(d.status) }];
    }
    case 'estimativa_custo': {
      const codigo = d.para ?? d.estimativaCusto;
      if (!ehEstimativaCusto(codigo)) return [{ rotulo: 'Estimativa', valor: 'Removida' }];
      const faixa = faixaEstimativaCusto(codigo);
      return codigo === 'I'
        ? [{ rotulo: 'Estimativa', valor: faixa }]
        : [
            { rotulo: 'Estimativa', valor: faixa },
            { rotulo: 'Faixa', valor: codigo },
          ];
    }
    case 'custo_final':
      return [{ rotulo: 'Custo final', valor: custo ?? 'Removido' }];
    default:
      return [{ rotulo: 'Status', valor: rotuloStatus(d.status) }];
  }
}

/** Rótulo do botão de ação por evento/destinatário. */
function botaoPorEvento(d: DadosEmailChamado): string {
  if (d.paraCliente === false) return 'Ver chamado';
  if (d.evento === 'resolvido') return 'Aprovar ou contestar';
  if (d.evento === 'mensagem_publica') return 'Responder no portal';
  return 'Ver chamado';
}

/** Renderiza o e-mail (assunto + texto + HTML) no layout único da plataforma (D-047). */
export function montarEmailChamado(d: DadosEmailChamado): EmailRenderizado {
  const { assunto, frase } = frasePorEvento(d);
  const custo = linhaCusto(d);

  // Trecho público: a mensagem (mensagem_publica) ou o MOTIVO da contestação.
  const mostraTrecho = d.evento === 'mensagem_publica' || d.evento === 'contestado';
  const trecho = mostraTrecho && d.trechoPublico ? d.trechoPublico : null;

  const texto = [
    frase,
    ``,
    `Chamado #${d.numero}: ${d.titulo}`,
    `Status: ${rotuloStatus(d.status)} · Prioridade: ${rotuloPrioridade(d.prioridade)}`,
    ...(custo ? [custo] : []),
    trecho ? `\n"${trecho}"\n` : ``,
    `Acesse: ${d.link}`,
    ``,
    rodapeTexto(),
  ].join('\n');

  // Detalhes do chamado como tópicos; o custo final só entra aqui se não for o destaque.
  const linhasDestaque = destaquePorEvento(d);
  const custoNoDestaque = linhasDestaque.some((l) => l.rotulo === 'Custo final');
  const est = rotuloEstimativa(d.estimativaCusto);
  const bullets = [
    `Status: ${negrito(escaparHtml(rotuloStatus(d.status)))}`,
    `Prioridade: ${negrito(escaparHtml(rotuloPrioridade(d.prioridade)))}`,
    ...(est ? [`Estimativa de custo: ${negrito(escaparHtml(est))}`] : []),
    ...(typeof d.custoFinal === 'number' && !custoNoDestaque
      ? [`Custo final: ${negrito(escaparHtml(formatarBrl(d.custoFinal)))}`]
      : []),
  ];

  const blocos = [secao({ paragrafo: escaparHtml(frase) }), divisoria()];
  if (trecho) {
    blocos.push(
      secao({
        titulo: d.evento === 'contestado' ? 'Motivo' : 'Mensagem',
        citacao: escaparHtml(trecho),
      }),
      divisoria(),
    );
  }
  blocos.push(secao({ titulo: escaparHtml(d.titulo), bullets }));
  if (linhasDestaque.length > 0) {
    blocos.push(
      divisoria(),
      destaque(
        linhasDestaque.map((l) => ({ rotulo: escaparHtml(l.rotulo), valor: escaparHtml(l.valor) })),
      ),
    );
  }
  blocos.push(botao(botaoPorEvento(d), d.link));

  const html = documento({
    titulo: tituloPorEvento(d),
    meta: [
      { rotulo: 'Chamado', valor: `#${d.numero}` },
      { rotulo: 'Data', valor: dataEmissao(d.emitidoEm) },
    ],
    corpo: blocos.join('\n'),
    nota: `Você recebeu este e-mail porque acompanha chamados em ${d.tenantNome}. Ajuste suas preferências de notificação no portal.`,
  });

  return { assunto, texto, html, imagensInline: [logoInline()] };
}

/** Dados para o e-mail de alerta ao admin (webhook desativado). */
export interface DadosAlertaWebhook {
  tenantNome: string;
  motivo: string;
  linkConfig: string;
  /** Data de emissão impressa no cabeçalho (padrão: agora). */
  emitidoEm?: Date;
}

export function montarEmailAlertaWebhook(d: DadosAlertaWebhook): EmailRenderizado {
  const assunto = `[Ação necessária] Webhook de notificações desativado`;
  const frase = `O webhook de notificações de ${d.tenantNome} foi DESATIVADO automaticamente após falhas consecutivas de entrega. Nenhuma notificação está sendo enviada por webhook até a reativação manual.`;
  const texto = `${frase}\n\nMotivo: ${d.motivo}\n\nCorrija o endpoint e reative em: ${d.linkConfig}\n\n${rodapeTexto()}`;
  const html = documento({
    titulo: 'Webhook desativado',
    meta: [{ rotulo: 'Data', valor: dataEmissao(d.emitidoEm) }],
    corpo: [
      secao({ paragrafo: escaparHtml(frase) }),
      divisoria(),
      secao({ titulo: 'Motivo', paragrafo: escaparHtml(d.motivo) }),
      botao('Reativar webhook', d.linkConfig),
    ].join('\n'),
  });
  return { assunto, texto, html, imagensInline: [logoInline()] };
}

/** Dados para o e-mail transacional (convite / reset de senha). */
export interface DadosEmailTransacional {
  tenantNome: string;
  tipo: 'convite' | 'reset_senha';
  url: string;
  /** Data de emissão impressa no cabeçalho (padrão: agora). */
  emitidoEm?: Date;
}

export function montarEmailTransacional(d: DadosEmailTransacional): EmailRenderizado {
  const conteudo =
    d.tipo === 'convite'
      ? {
          assunto: `Você foi convidado para ${d.tenantNome}`,
          titulo: 'Convite de acesso',
          frase: `Você foi convidado para acessar o suporte de ${d.tenantNome}. Clique abaixo para criar sua senha e ativar o acesso.`,
          botao: 'Aceitar convite',
        }
      : {
          assunto: `Redefinição de senha — ${d.tenantNome}`,
          titulo: 'Redefinição de senha',
          frase: `Recebemos um pedido para redefinir sua senha em ${d.tenantNome}. Se foi você, clique abaixo. O link expira em breve.`,
          botao: 'Redefinir senha',
        };
  const texto = `${conteudo.frase}\n\n${conteudo.botao}: ${d.url}\n\n${rodapeTexto()}`;
  const html = documento({
    titulo: conteudo.titulo,
    meta: [{ rotulo: 'Data', valor: dataEmissao(d.emitidoEm) }],
    corpo: [
      secao({ paragrafo: escaparHtml(conteudo.frase) }),
      botao(conteudo.botao, d.url, true),
    ].join('\n'),
  });
  return { assunto: conteudo.assunto, texto, html, imagensInline: [logoInline()] };
}

/**
 * Objeto `estimativa_custo` do payload (D-043): código + rótulo canônico +
 * limites da faixa. `null` para ausente (ou código desconhecido — nunca inventa).
 */
export function estimativaParaPayload(
  codigo: string | null | undefined,
): PayloadWebhook['chamado']['estimativa_custo'] {
  if (!ehEstimativaCusto(codigo)) return null;
  const f = FAIXAS_ESTIMATIVA_CUSTO[codigo];
  return { codigo, rotulo: rotuloEstimativaCusto(codigo), min: f.min, max: f.max };
}

/** Monta o payload do webhook (specs/06 §3.2) — sem conteúdo interno. */
export interface DadosWebhook {
  webhookTipo: PayloadWebhook['evento']['tipo'];
  eventoId: string;
  eventoTs: string;
  chamado: PayloadWebhook['chamado'];
  autorNome?: string | null;
  trechoPublico?: string | null;
  /** Texto (status/prioridade/código da faixa) ou número (custo final em BRL — D-043). */
  de?: string | number | null;
  para?: string | number | null;
  link: string;
  incluiMensagem: boolean;
  incluiMudanca: boolean;
  /** Inclui `autor` mesmo sem mensagem (aprovação explícita — D-042). */
  incluiAutor?: boolean;
  /** D-042: forma da aprovação — preenche `aprovacao` (só no tipo `aprovado`). */
  aprovacao?: 'explicita' | 'tacita' | null;
}

export function montarPayloadWebhook(d: DadosWebhook): PayloadWebhook {
  const comAutor = d.incluiMensagem || d.incluiAutor === true;
  return {
    evento: { tipo: d.webhookTipo, id: d.eventoId, timestamp: d.eventoTs },
    chamado: d.chamado,
    autor: comAutor && d.autorNome ? { nome: d.autorNome } : null,
    mensagem: d.incluiMensagem && d.trechoPublico ? { trecho: d.trechoPublico } : null,
    mudanca: d.incluiMudanca ? { de: d.de ?? null, para: d.para ?? null } : null,
    aprovacao: d.webhookTipo === 'aprovado' && d.aprovacao ? { forma: d.aprovacao } : null,
    linkChamado: d.link,
  };
}
