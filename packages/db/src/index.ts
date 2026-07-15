export { conexaoBase, credenciaisAdmin, credenciaisApp } from './config';
export {
  criarAppDataSource,
  criarAdminDataSource,
  obterAppDataSource,
} from './data-source';
export { runInTenantContext } from './rls';
export { verificarPostgres } from './health';
export { TenantSchema, type Tenant, type ConfigBranding } from './entities/tenant';
export { UsuarioSchema, type Usuario } from './entities/usuario';
export { SessaoSchema, type Sessao } from './entities/sessao';
export { ConviteSchema, type Convite } from './entities/convite';
export {
  RedefinicaoSenhaSchema,
  type RedefinicaoSenha,
} from './entities/redefinicao-senha';
export { SegredoSchema, type Segredo } from './entities/segredo';
export {
  SistemaAlvoSchema,
  type SistemaAlvo,
  type LogsConfig,
} from './entities/sistema-alvo';
export { CategoriaSchema, type Categoria } from './entities/categoria';
export {
  ChamadoSchema,
  type Chamado,
  type DocRichText,
} from './entities/chamado';
export { MensagemSchema, type Mensagem } from './entities/mensagem';
export { AnexoSchema, type Anexo } from './entities/anexo';
export {
  EventoChamadoSchema,
  type EventoChamado,
} from './entities/evento-chamado';
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
  gravarEvento,
  type Auditar,
  type HooksChamado,
  type EventoChamadoPendente,
} from './chamados/auditoria';

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
export {
  listarEventos,
  type EventoView,
} from './chamados/evento-service';
