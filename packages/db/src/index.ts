export { conexaoBase, credenciaisAdmin, credenciaisApp, permitirRepoLocal } from './config';
export { criarAppDataSource, criarAdminDataSource, obterAppDataSource } from './data-source';
export { runInTenantContext } from './rls';
export { verificarPostgres } from './health';
// ---- M10 (hardening): rate limiting reutilizável (Redis) -------------------
export {
  consumirRateLimit,
  aplicarLimite,
  mensagemRateLimit,
  rateLimitHabilitado,
  fecharRateLimit,
  type AcaoRateLimit,
  type ResultadoRateLimit,
  type ResultadoLimite,
} from './rate-limit';
export { TenantSchema, type Tenant, type ConfigBranding } from './entities/tenant';
export { UsuarioSchema, type Usuario } from './entities/usuario';
export { SessaoSchema, type Sessao } from './entities/sessao';
export { ConviteSchema, type Convite } from './entities/convite';
export { RedefinicaoSenhaSchema, type RedefinicaoSenha } from './entities/redefinicao-senha';
export { SegredoSchema, type Segredo } from './entities/segredo';
export { SistemaAlvoSchema, type SistemaAlvo, type LogsConfig } from './entities/sistema-alvo';
export { CategoriaSchema, type Categoria } from './entities/categoria';
export { ChamadoSchema, type Chamado, type DocRichText } from './entities/chamado';
export { MensagemSchema, type Mensagem } from './entities/mensagem';
export { AnexoSchema, type Anexo } from './entities/anexo';
export { EventoChamadoSchema, type EventoChamado } from './entities/evento-chamado';
export { ExecucaoIASchema, type ExecucaoIA } from './entities/execucao-ia';
export * from './auth';

// ---- M2: cofre de segredos, sistemas-alvo, categorias, config do tenant ----
export {
  type SecretStore,
  envelopeSecretStore,
  criarSecretStore,
  mascararSegredo,
  MASCARA_SEGREDO,
} from './secrets/secret-store';
export {
  cifrarEnvelope,
  decifrarEnvelope,
  carregarChaveMestra,
  _resetChaveMestraCache,
  type EnvelopeCifrado,
} from './secrets/crypto';
export {
  listarSistemasAlvo,
  buscarSistemaAlvo,
  criarSistemaAlvo,
  atualizarSistemaAlvo,
  definirAtivoSistemaAlvo,
  salvarConhecimentoSistema,
  toResumoSistemaAlvo,
  type SistemaAlvoResumo,
  type EntradaSistemaAlvo,
} from './sistemas/sistema-alvo-service';
export {
  NOME_CATEGORIA_GERAL,
  ehCategoriaGeral,
  garantirCategoriaGeral,
  listarCategorias,
  buscarCategoria,
  criarCategoria,
  editarCategoria,
  removerCategoria,
  type ResultadoCategoria,
} from './categorias/categoria-service';
export {
  carregarTenant,
  atualizarBranding,
  atualizarNomeExibicao,
  atualizarConfigGeral,
  definirDominioProprio,
  type ConfigGeral,
  type ResultadoDominio,
} from './tenants/config-service';

// ---- M3: Chamado (entidade, numeração, máquina de estados, serviços) -------
export {
  LIMITE_TITULO_MIN,
  LIMITE_TITULO_MAX,
  LIMITE_CORPO_MAX,
  atorSistema,
  toChamadoInterno,
  criarChamado,
  obterChamado,
  listarChamados,
  transicionarStatus,
  atribuirOperador,
  desatribuirOperador,
  alterarPrioridade,
  definirComplexidade,
  alterarNatureza,
  motivoRichParaCriar,
  type AtorChamado,
  type AtorTransicao,
  type ChamadoView,
  type EntradaCriarChamado,
  type ResultadoCriar,
  type MotivoCriar,
  type ResultadoTransicionar,
  type MotivoTransicionar,
  type ResultadoMutacao,
  type MotivoMutacao,
  type FiltrosChamado,
  type PaginaChamados,
  type Atribuicao,
} from './chamados/chamado-service';
export {
  auditarNoop,
  auditorDe,
  despacharDe,
  gravarEvento,
  type Auditar,
  type HooksChamado,
  type EventoChamadoPendente,
} from './chamados/auditoria';
export { despachanteNoop, type Despachante, type EventoDominio } from './chamados/eventos-dominio';

// ---- M4: rich text, mensagens, anexos, eventos (E-10, E-11, E-12, E-15) ----
export {
  validarDocRico,
  materializarDoc,
  renderizarHtml,
  textoParaDoc,
  normalizarEntradaRich,
  escaparHtml,
  PREFIXO_REF_ANEXO,
  type DocRico,
  type NoRichText,
  type MarcaRichText,
  type DocValidado,
  type ImagemColada,
  type MotivoRichText,
} from './chamados/rich-text';
export {
  detectarTipo,
  detectarImagemInline,
  TAMANHO_MAX_ANEXO_BYTES,
  MAX_ANEXOS_POR_MENSAGEM,
  MAX_IMAGENS_INLINE,
  type TipoDetectado,
  type CategoriaArquivo,
  type ResultadoDeteccao,
  type MotivoArquivo,
} from './chamados/validacao-arquivo';
export {
  criarMensagem,
  listarMensagens,
  type EntradaMensagem,
  type ResultadoMensagem,
  type MotivoMensagem,
  type MensagemTimeline,
} from './chamados/mensagem-service';
export {
  gravarAnexo,
  autorizarDownloadAnexo,
  listarAnexosDaMensagem,
  type AtorAnexo,
  type ArquivoUpload,
  type AlvoAnexo,
  type ResultadoDownload,
  type MotivoDownload,
} from './chamados/anexo-service';
export { listarEventos, type EventoView } from './chamados/evento-service';

// ---- M5: consultas read-only do painel operador/admin (fila + dashboard) ----
export {
  listarFilaChamados,
  contarFila,
  listarOperadoresDoTenant,
  type FiltrosFila,
  type AtribuicaoFila,
  type FilaChamadoItem,
  type PaginaFila,
  type ContadoresFila,
  type OperadorResumo,
} from './chamados/consulta-service';
export {
  metricasDashboard,
  blocosPrecisaDeVoce,
  prsIaAguardandoRevisao,
  type MetricasDashboard,
  type ItemAcionavel,
  type BlocosPrecisaDeVoce,
  type ItemPrIa,
} from './chamados/dashboard-service';

// ---- M6: fila de triagem (publicador) + serviço de ExecucaoIA (E-16, E-22) -
export {
  NOME_FILA_TRIAGEM,
  NOME_JOB_TRIAGEM,
  filaTriagem,
  enfileirarTriagem,
  jobIdTriagem,
  prefixoJobChamado,
  opcoesJobTriagem,
  debounceSegundos,
  DespachanteFila,
  NOME_FILA_MAPEAMENTO,
  NOME_JOB_MAPEAMENTO,
  filaMapeamento,
  enfileirarMapeamento,
  jobIdMapeamento,
  opcoesJobMapeamento,
  fecharFilaMapeamento,
  type JobTriagem,
  type OpcoesEnfileirar,
  type JobMapeamento,
} from './fila';
export {
  criarExecucao,
  marcarExecutando,
  concluirExecucao,
  concluirExecucaoMapeamento,
  falharExecucao,
  existeConcluidaParaMensagem,
  listarExecucoesDoChamado,
  listarExecucoesDoSistema,
  type EntradaCriarExecucao,
  type ExecucaoIAView,
} from './chamados/execucao-ia-service';

// ---- M9: notificações (canais, preferências, dispatcher, fila) — E-25..E-28,E-33
export {
  CanalNotificacaoSchema,
  type CanalNotificacao,
  type ConfigCanal,
} from './entities/canal-notificacao';
export {
  PreferenciaNotificacaoSchema,
  type PreferenciaNotificacao,
} from './entities/preferencia-notificacao';
export { NotificacaoLogSchema, type NotificacaoLog } from './entities/notificacao-log';
export {
  CanalNotificacaoTipo,
  StatusNotificacao,
  statusEhSucesso,
  EventoNotificavel,
  CATALOGO_NOTIFICACOES,
  eventoNotificavelDe,
  eventosDoPapel,
  eObrigatorio,
  papelDestinatario,
  chaveIdempotencia,
  chaveIdempotenciaTransacional,
  assinarWebhook,
  listarCanais,
  buscarCanal,
  idCanalEmail,
  toWebhookView,
  salvarWebhook,
  definirWebhookAtivo,
  lerSegredoWebhook,
  registrarFalhaWebhook,
  zerarFalhasWebhook,
  validarUrlWebhook,
  hostWebhookPrivado,
  permitirWebhookPrivado,
  WebhookUrlInvalidaError,
  type MotivoUrlWebhook,
  type ResultadoUrlWebhook,
  preferenciaHabilitada,
  listarPreferenciasUsuario,
  definirPreferencia,
  resolverJobs,
  despacharNotificacoes,
  NOME_FILA_NOTIFICACOES,
  NOME_JOB_NOTIFICACAO,
  filaNotificacoes,
  enfileirarNotificacao,
  opcoesJobNotificacao,
  DespachanteNotificacoes,
  garantirCanaisNotificacaoDefault,
  type PapelDestinatario,
  type WebhookTipo,
  type EntradaCatalogo,
  type ContextoNotificacao,
  type JobNotificacao,
  type JobTransacional,
  type JobAlertaWebhook,
  type JobFila,
  type PayloadWebhook,
  type WebhookView,
  type EntradaWebhook,
  type PreferenciaItem,
  type MotivoPreferencia,
  type ResultadoPreferencia,
  type EventoAuditavel,
} from './notificacoes';

// ---- M10: busca full-text + auto-fechamento (E-31, specs/04 §8.1/§10.4) -----
export {
  interpretarBusca,
  exprMatchFts,
  exprRankFts,
  FTS_MIN_CHARS,
  type ModoBusca,
} from './chamados/busca';
export {
  listarTenantsAtivos,
  fecharChamadosResolvidosVencidos,
  marcarExecucoesOrfas,
  listarChamadosEncalhadosEmTriagem,
  type ResultadoAutoFechamento,
  type ExecucaoOrfa,
} from './chamados/manutencao-service';
