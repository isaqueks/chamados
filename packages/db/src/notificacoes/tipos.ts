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
} as const;
export type EventoNotificavel = (typeof EventoNotificavel)[keyof typeof EventoNotificavel];

/** Papel de destinatário considerado na resolução (humanos; agente_ia nunca recebe). */
export type PapelDestinatario = 'cliente' | 'operador';

/** Categoria do webhook (os 7 tipos da D-003, specs/06 §3.2). */
export type WebhookTipo =
  | 'criado'
  | 'mensagem_publica'
  | 'status_alterado'
  | 'prioridade_alterada'
  | 'atribuicao'
  | 'resolvido'
  | 'fechado';

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
    descricao: 'O chamado foi marcado como resolvido.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: ['cliente'],
    webhook: 'resolvido',
  },
  fechado: {
    rotulo: 'Chamado fechado',
    descricao: 'O chamado foi fechado.',
    destinatarios: ['cliente', 'operador'],
    obrigatorio: [],
    webhook: 'fechado',
  },
  reaberto: {
    rotulo: 'Chamado reaberto',
    descricao: 'Um chamado resolvido voltou para atendimento.',
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
    case 'chamado_fechado_auto':
      return EventoNotificavel.fechado;
    case 'chamado_reaberto':
      return EventoNotificavel.reaberto;
    case 'chamado_cancelado':
      return EventoNotificavel.cancelado;
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
  };
  /** Autor e trecho PÚBLICO da mensagem (só em `mensagem_publica`). */
  autor?: { nome: string } | null;
  mensagem?: { trecho: string } | null;
  /** Mudança (status/prioridade), quando aplicável. */
  mudanca?: { de: string | null; para: string | null } | null;
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
