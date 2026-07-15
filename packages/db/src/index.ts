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
