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
  textoParaDescricao,
  comprimentoTextoDescricao,
} from './chamados/rich-text-provisorio';
export {
  auditarNoop,
  auditorDe,
  type Auditar,
  type HooksChamado,
  type EventoChamadoPendente,
} from './chamados/auditoria';
