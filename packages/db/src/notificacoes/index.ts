/** Camada de notificações (M9 — specs/06). Barrel do módulo. */
export {
  CanalNotificacaoTipo,
  StatusNotificacao,
  statusEhSucesso,
  EventoNotificavel,
  CATALOGO_NOTIFICACOES,
  eventoNotificavelDe,
  eventosDoPapel,
  eObrigatorio,
  defaultDoEvento,
  papelDestinatario,
  chaveIdempotencia,
  chaveIdempotenciaTransacional,
  assinarWebhook,
  type PapelDestinatario,
  type WebhookTipo,
  type EntradaCatalogo,
  type ContextoNotificacao,
  type JobNotificacao,
  type JobTransacional,
  type JobAlertaWebhook,
  type JobFila,
  type PayloadWebhook,
} from './tipos';
export {
  listarCanais,
  buscarCanal,
  idCanalEmail,
  toWebhookView,
  salvarWebhook,
  definirWebhookAtivo,
  lerSegredoWebhook,
  registrarFalhaWebhook,
  zerarFalhasWebhook,
  type WebhookView,
  type EntradaWebhook,
} from './canal-service';
export {
  preferenciaHabilitada,
  listarPreferenciasUsuario,
  definirPreferencia,
  type PreferenciaItem,
  type MotivoPreferencia,
  type ResultadoPreferencia,
} from './preferencia-service';
export { resolverJobs, despacharNotificacoes, type EventoAuditavel } from './dispatcher';
export {
  validarUrlWebhook,
  hostWebhookPrivado,
  permitirWebhookPrivado,
  WebhookUrlInvalidaError,
  type MotivoUrlWebhook,
  type ResultadoUrlWebhook,
} from './validar-url-webhook';
export {
  NOME_FILA_NOTIFICACOES,
  NOME_JOB_NOTIFICACAO,
  filaNotificacoes,
  enfileirarNotificacao,
  opcoesJobNotificacao,
  DespachanteNotificacoes,
} from './fila-notificacoes';
export { garantirCanaisNotificacaoDefault } from './provisionamento';
