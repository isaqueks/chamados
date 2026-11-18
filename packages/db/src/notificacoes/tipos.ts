import { createHash, createHmac } from 'node:crypto';
import { Papel, type TipoEvento } from '@chamados/shared';

/**
 * Tipos, enums e catálogo canônico da camada de notificações (specs/06). Vive em
 * `@chamados/db` porque é compartilhado pelo DESPACHANTE (web/despacho, resolve
 * destinatários e enfileira) e pelo PROCESSADOR (worker, renderiza e entrega).
 *
 * IMPORTANTE (divergência de nome de tipo relatada): specs/02 nomeia o ENUM de
 * canal como `canal_notificacao`, mas esse é também o nome da TABELA
 * `canal_notificacao` — no PostgreSQL tabela e tipo compartilham namespace e
 * colidiriam. O ENUM nativo é criado como `canal_notificacao_tipo` (a tabela
 * permanece `canal_notificacao`). Ver entrega do M9.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Tipo de canal de saída (adapter pattern — specs/06 §2.1). Fase 1: email + webhook. */
export const CanalNotificacaoTipo = {
  email: 'email',
  whatsapp: 'whatsapp',
  sms: 'sms',
  push: 'push',
  webhook: 'webhook',
} as const;
export type CanalNotificacaoTipo = (typeof CanalNotificacaoTipo)[keyof typeof CanalNotificacaoTipo];

/**
 * Status de uma linha de `NotificacaoLog` (base da idempotência — specs/06 §8.3).
 * `entregue`/`aceito` = terminal de sucesso (reprocesso é SKIP);
 * `falha_temporaria` = re-tenta (fila); `falha_permanente` = descarta (DLQ).
 */
export const StatusNotificacao = {
  pendente: 'pendente',
  entregue: 'entregue',
  aceito: 'aceito',
  falha_temporaria: 'falha_temporaria',
  falha_permanente: 'falha_permanente',
} as const;
export type StatusNotificacao = (typeof StatusNotificacao)[keyof typeof StatusNotificacao];

/** Um status terminal de sucesso NUNCA é reenviado (idempotência — specs/06 §8.3). */
export function statusEhSucesso(s: StatusNotificacao): boolean {
  return s === StatusNotificacao.entregue || s === StatusNotificacao.aceito;
}

// ---------------------------------------------------------------------------
// Catálogo de eventos notificáveis (specs/06 §5, §6)
// ---------------------------------------------------------------------------

/**
 * Chaves canônicas de evento NOTIFICÁVEL (usadas em `PreferenciaNotificacao.evento`
 * e na UI de preferências). Subconjunto derivado da matriz specs/06 §6 — NÃO é a
 * taxonomia de auditoria (`TipoEvento`), que é mais granular.
 */
export const EventoNotificavel = {
  chamado_criado: 'chamado_criado',
  mensagem_publica: 'mensagem_publica',
  mudanca_status: 'mudanca_status',
  mudanca_prioridade: 'mudanca_prioridade',
  atribuicao: 'atribuicao',
  resolvido: 'resolvido',
  fechado: 'fechado',
  reaberto: 'reaberto',
  cancelado: 'cancelado',
  /** D-042: o cliente aprovou a resolução (explicitamente ou pelo prazo vencido). */
  aprovado: 'aprovado',
  /** D-042: o cliente contestou a resolução (com motivo) e o chamado voltou ao atendimento. */
  contestado: 'contestado',
  /** D-043: a equipe definiu, alterou ou removeu a estimativa de custo. */
  estimativa_custo: 'estimativa_custo',
  /** D-043: a equipe informou/corrigiu o custo final de um chamado resolvido (fora do ato de resolver). */
  custo_final: 'custo_final',
} as const;
export type EventoNotificavel = (typeof EventoNotificavel)[keyof typeof EventoNotificavel];

/** Papel de destinatário considerado na resolução (humanos; agente_ia nunca recebe). */
export type PapelDestinatario = 'cliente' | 'operador';

/**
 * Categoria do webhook (specs/06 §3.2): os 7 tipos da D-003 + `aprovado` e
 * `contestado` (D-042). `fechado` passa a significar SÓ o fechamento manual pela
 * equipe; o encerramento pelo aceite do cliente (explícito ou tácito) sai como
 * `aprovado` — nunca os dois para o mesmo fato. D-043: `estimativa_custo_alterada`
 * e `custo_final_definido` (este só FORA do ato de resolver — no ato, o próprio
 * `resolvido` leva `chamado.custo_final`).
 */
export type WebhookTipo =
  | 'criado'
  | 'mensagem_publica'
  | 'status_alterado'
  | 'prioridade_alterada'
  | 'atribuicao'
  | 'resolvido'
  | 'fechado'
  | 'aprovado'
  | 'contestado'
  | 'estimativa_custo_alterada'
  | 'custo_final_definido';

export interface EntradaCatalogo {
  /** Rótulo pt-BR exibido na UI de preferências. */
  rotulo: string;
  /** Descrição curta para a UI. */
  descricao: string;
  /** Papéis que podem receber este evento (matriz §6). */
  destinatarios: PapelDestinatario[];
  /** Papéis para os quais o evento é OBRIGATÓRIO (não desabilitável — §7). */
  obrigatorio: PapelDestinatario[];
  /** O autor da ação recebe (confirmação — ex.: abertura/reabertura). Default: não. */
  confirmacaoAutor?: boolean;
  /**
   * Evento RUIDOSO: sem linha de preferência, nasce DESLIGADO (opt-in — §7).
   * Anti-flood: uma triagem normal transita status/prioridade várias vezes em
   * minutos; quem quiser esse nível de detalhe liga na página de preferências.
   */
  padraoDesligado?: boolean;
  /** Categoria de webhook disparada (null = não dispara webhook). */
  webhook: WebhookTipo | null;
}

/** Catálogo canônico (specs/06 §5, §6). Fonte única para despacho, UI e webhook. */
export const CATALOGO_NOTIFICACOES: Record<EventoNotificavel, EntradaCatalogo> = {
  chamado_criado: {
    rotulo: 'Chamado criado',
    descricao: 'Confirmação de abertura para o solicitante.',
    destinatarios: ['cliente'],
    obrigatorio: ['cliente'],
    confirmacaoAutor: true,
    webhook: 'criado',
  },
  mensagem_publica: {
    rotulo: 'Nova mensagem pública',
    descricao: 'Resposta pública na timeline do chamado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'mensagem_publica',
  },
  mudanca_status: {
    rotulo: 'Mudança de status',
    descricao: 'Transição de status do chamado (em triagem, em atendimento…).',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    // Ruído: a triagem move o status várias vezes em minutos; os desfechos que
    // importam (resolvido/fechado/reaberto/cancelado) têm eventos PRÓPRIOS.
    padraoDesligado: true,
    webhook: 'status_alterado',
  },
  mudanca_prioridade: {
    rotulo: 'Mudança de prioridade',
    descricao: 'Alteração da prioridade do chamado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    padraoDesligado: true,
    webhook: 'prioridade_alterada',
  },
  atribuicao: {
    rotulo: 'Atribuição de chamado',
    descricao: 'Você passou a ser o responsável por um chamado.',
    destinatarios: ['operador'],
    obrigatorio: ['operador'],
    webhook: 'atribuicao',
  },
  resolvido: {
    rotulo: 'Chamado resolvido',
    descricao:
      'O chamado foi marcado como resolvido — o cliente tem um prazo para aprovar ou contestar.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: ['cliente'],
    webhook: 'resolvido',
  },
  fechado: {
    rotulo: 'Chamado fechado',
    // D-042: só o fechamento MANUAL pela equipe; o aceite do cliente é `aprovado`.
    descricao: 'A equipe fechou o chamado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'fechado',
  },
  reaberto: {
    rotulo: 'Chamado reaberto',
    descricao: 'Um chamado resolvido, fechado ou cancelado voltou para atendimento.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: ['operador'],
    confirmacaoAutor: true,
    // Reabertura é uma transição de status → webhook como status_alterado.
    webhook: 'status_alterado',
  },
  cancelado: {
    rotulo: 'Chamado cancelado',
    descricao: 'O chamado foi cancelado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'status_alterado',
  },
  aprovado: {
    rotulo: 'Chamado aprovado',
    descricao:
      'O cliente aprovou a solução — ou o prazo para aprovar ou contestar terminou sem resposta.',
    // O cliente que aprova explicitamente não recebe (é o autor); na aprovação
    // tácita (ator = sistema) ele é avisado de que o chamado foi encerrado.
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'aprovado',
  },
  contestado: {
    rotulo: 'Solução contestada',
    descricao: 'O cliente contestou a solução e o chamado voltou para atendimento.',
    // Quem contesta é sempre o solicitante (o autor) — só a equipe é avisada.
    destinatarios: ['operador'],
    obrigatorio: ['operador'],
    webhook: 'contestado',
  },
  estimativa_custo: {
    rotulo: 'Estimativa de custo',
    descricao: 'A equipe definiu ou alterou a faixa de custo estimada do chamado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    // Alteração de campo, como prioridade: opt-in (anti-flood — specs/06 §7).
    padraoDesligado: true,
    webhook: 'estimativa_custo_alterada',
  },
  custo_final: {
    rotulo: 'Custo final',
    descricao: 'O custo final de um chamado resolvido foi informado ou corrigido.',
    // Raro e humano (só em `resolvido`, fora do ato de resolver) e muda o valor
    // que o cliente está aprovando: ligado por padrão, mas desabilitável.
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'custo_final_definido',
  },
};

/**
 * Mapeia um `TipoEvento` de auditoria para a chave notificável (ou `null` quando
 * NÃO gera notificação — ex.: nota interna, complexidade, ações internas da IA).
 * Nota interna, complexidade e eventos `ia_*` NUNCA notificam (specs/06 §5, §3.2).
 */
export function eventoNotificavelDe(tipo: TipoEvento): EventoNotificavel | null {
  switch (tipo) {
    case 'chamado_criado':
      return EventoNotificavel.chamado_criado;
    case 'mensagem_publicada':
      return EventoNotificavel.mensagem_publica;
    case 'status_alterado':
      return EventoNotificavel.mudanca_status;
    case 'prioridade_alterada':
      return EventoNotificavel.mudanca_prioridade;
    case 'operador_atribuido':
    case 'operador_desatribuido':
      return EventoNotificavel.atribuicao;
    case 'chamado_resolvido':
      return EventoNotificavel.resolvido;
    case 'chamado_fechado':
      return EventoNotificavel.fechado;
    // D-042: aprovação explícita (cliente) e TÁCITA (prazo vencido — o
    // `chamado_fechado_auto`) são o mesmo fato para quem é notificado.
    case 'chamado_aprovado':
    case 'chamado_fechado_auto':
      return EventoNotificavel.aprovado;
    case 'chamado_contestado':
      return EventoNotificavel.contestado;
    case 'chamado_reaberto':
      return EventoNotificavel.reaberto;
    case 'chamado_cancelado':
      return EventoNotificavel.cancelado;
    // D-043. O `custo_final_definido` gravado NO ATO de resolver (`origem:
    // 'resolucao'`) é descartado no dispatcher — o `resolvido` já o comunica.
    case 'estimativa_custo_alterada':
      return EventoNotificavel.estimativa_custo;
    case 'custo_final_definido':
      return EventoNotificavel.custo_final;
    // nota_interna_publicada, natureza_alterada, complexidade_alterada,
    // anexo_adicionado, ia_* → nunca notificam (conteúdo interno / ruído).
    default:
      return null;
  }
}

/** Lista os eventos que o papel pode configurar na UI de preferências. */
export function eventosDoPapel(papel: PapelDestinatario): EventoNotificavel[] {
  return (Object.keys(CATALOGO_NOTIFICACOES) as EventoNotificavel[]).filter((k) =>
    CATALOGO_NOTIFICACOES[k].destinatarios.includes(papel),
  );
}

/** O evento é obrigatório (não desabilitável) para o papel? (specs/06 §7). */
export function eObrigatorio(evento: EventoNotificavel, papel: PapelDestinatario): boolean {
  return CATALOGO_NOTIFICACOES[evento].obrigatorio.includes(papel);
}

/**
 * Default EFETIVO do evento quando o usuário nunca definiu preferência (§7):
 * eventos ruidosos (`padraoDesligado`) nascem desligados (opt-in); os demais,
 * ligados. Fonte ÚNICA do default — dispatcher, serviço e UI usam esta função.
 */
export function defaultDoEvento(evento: EventoNotificavel): boolean {
  return CATALOGO_NOTIFICACOES[evento].padraoDesligado !== true;
}

/** Converte o `Papel` do usuário no `PapelDestinatario` (ou `null` se não recebe). */
export function papelDestinatario(papel: Papel): PapelDestinatario | null {
  if (papel === Papel.cliente) return 'cliente';
  if (papel === Papel.operador || papel === Papel.admin) return 'operador';
  return null; // agente_ia nunca recebe notificação.
}

// ---------------------------------------------------------------------------
// Job de notificação (payload da fila `notificacoes`)
// ---------------------------------------------------------------------------

/** Contexto mínimo carregado no job para compor webhook/e-mail sem re-resolver. */
export interface ContextoNotificacao {
  /** Autor da ação (para excluir do texto / compor "autor" no webhook). */
  autorId: string | null;
  /** Mensagem que originou o evento (mensagem pública). */
  mensagemId?: string | null;
  /** Transições/mudanças: valor anterior e novo (status/prioridade). */
  de?: string | null;
  para?: string | null;
  /** D-042: forma da aprovação (só no evento `aprovado`). */
  aprovacao?: 'explicita' | 'tacita' | null;
  /** D-043: valores anterior/novo do custo final em BRL (só no evento `custo_final`). */
  custo?: { de: number | null; para: number | null } | null;
}

/** Um job de notificação por (destinatário × canal) OU por webhook (tenant). */
export interface JobNotificacao {
  especie: 'chamado';
  /** Chave determinística (idempotência de ponta a ponta — specs/06 §8.3). */
  idempotencyKey: string;
  tenantId: string;
  /** Id lógico do evento (estável para a idempotência). */
  eventoNotifId: string;
  /** Timestamp ISO do evento (para o payload do webhook). */
  eventoTs: string;
  evento: EventoNotificavel;
  chamadoId: string;
  canal: 'email' | 'webhook';
  /** Destinatário humano (e-mail); ausente no webhook (canal por tenant). */
  destinatarioId?: string | null;
  contexto: ContextoNotificacao;
}

/** E-mail transacional de autenticação (convite / reset de senha — specs/03). */
export interface JobTransacional {
  especie: 'transacional';
  idempotencyKey: string;
  tenantId: string;
  canal: 'email';
  tipo: 'convite' | 'reset_senha';
  destinatarioEmail: string;
  destinatarioNome?: string | null;
  /** Link de ação (aceitar convite / redefinir senha). */
  url: string;
}

/** Alerta ao admin de que o webhook foi desativado por falhas (specs/06 §3.2). */
export interface JobAlertaWebhook {
  especie: 'alerta_webhook';
  idempotencyKey: string;
  tenantId: string;
  canal: 'email';
  destinatarioId: string;
  /** Motivo/erro que levou à desativação (para o corpo do alerta). */
  motivo: string;
}

/** Payload polimórfico da fila `notificacoes`. */
export type JobFila = JobNotificacao | JobTransacional | JobAlertaWebhook;

// ---------------------------------------------------------------------------
// Payload do webhook (specs/06 §3.2) — NUNCA inclui conteúdo interno
// ---------------------------------------------------------------------------

export interface PayloadWebhook {
  evento: { tipo: WebhookTipo; id: string; timestamp: string };
  chamado: {
    id: string;
    numero: string;
    titulo: string;
    status: string;
    prioridade: string;
    natureza: string;
    sistema_alvo: string | null;
    categoria: string | null;
    /**
     * D-043: SEMPRE presente (null = sem estimativa). Código + rótulo canônico +
     * limites da faixa em BRL (`max: null` = sem teto, faixa E).
     */
    estimativa_custo: {
      codigo: string;
      rotulo: string;
      min: number;
      max: number | null;
    } | null;
    /** D-043: SEMPRE presente. Custo final em BRL (null = não informado). */
    custo_final: number | null;
  };
  /**
   * Quem praticou a ação, quando é relevante ao integrador: autor da mensagem
   * (`mensagem_publica`), o cliente que contestou (`contestado`) ou que aprovou
   * explicitamente (`aprovado` com `forma: 'explicita'`). Só o NOME.
   */
  autor?: { nome: string } | null;
  /** Trecho PÚBLICO da mensagem (`mensagem_publica`; em `contestado`, o motivo). */
  mensagem?: { trecho: string } | null;
  /**
   * Mudança, quando aplicável: status/prioridade; de/para em `aprovado`/
   * `contestado`; códigos da faixa em `estimativa_custo_alterada`; valores em
   * BRL (número) em `custo_final_definido`.
   */
  mudanca?: { de: string | number | null; para: string | number | null } | null;
  /** D-042: só em `aprovado` — `explicita` (o cliente aprovou) ou `tacita` (prazo vencido). */
  aprovacao?: { forma: 'explicita' | 'tacita' } | null;
  linkChamado: string;
}

// ---------------------------------------------------------------------------
// Idempotência
// ---------------------------------------------------------------------------

/**
 * Chave de idempotência determinística (specs/06 §8.3):
 *  - e-mail:  hash(eventoNotifId + destinatarioId + 'email')
 *  - webhook: hash(eventoNotifId + tenantId + 'webhook')
 * Também é usada como `jobId` do BullMQ (dedupe de enfileiramento).
 */
export function chaveIdempotencia(partes: {
  eventoNotifId: string;
  canal: 'email' | 'webhook';
  destinatarioId?: string | null;
  tenantId: string;
}): string {
  const semente =
    partes.canal === 'webhook'
      ? `${partes.eventoNotifId}|${partes.tenantId}|webhook`
      : `${partes.eventoNotifId}|${partes.destinatarioId ?? ''}|email`;
  return createHash('sha256').update(semente).digest('hex');
}

/** Chave de idempotência de e-mails transacionais (convite/reset). */
export function chaveIdempotenciaTransacional(tipo: string, token: string): string {
  return createHash('sha256').update(`transacional|${tipo}|${token}`).digest('hex');
}

/**
 * Assinatura HMAC SHA-256 do corpo do webhook (specs/06 §3.2). Formato
 * `sha256=<hex>` — o receptor recalcula com o mesmo segredo. Fonte ÚNICA usada
 * tanto pelo adapter do worker quanto pelo "evento de teste" da UI de config.
 */
export function assinarWebhook(segredo: string, corpo: string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;
}
