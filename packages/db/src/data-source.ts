import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { conexaoBase, credenciaisAdmin, credenciaisApp } from './config';
import { TenantSchema } from './entities/tenant';
import { UsuarioSchema } from './entities/usuario';
import { SessaoSchema } from './entities/sessao';
import { ConviteSchema } from './entities/convite';
import { RedefinicaoSenhaSchema } from './entities/redefinicao-senha';
import { SegredoSchema } from './entities/segredo';
import { SistemaAlvoSchema } from './entities/sistema-alvo';
import { CategoriaSchema } from './entities/categoria';
import { ChamadoSchema } from './entities/chamado';
import { MensagemSchema } from './entities/mensagem';
import { AnexoSchema } from './entities/anexo';
import { EventoChamadoSchema } from './entities/evento-chamado';
import { ExecucaoIASchema } from './entities/execucao-ia';
import { Init1720000000000 } from './migrations/0000-init';
import { Auth1720000001000 } from './migrations/0001-auth';
import { M21720000002000 } from './migrations/0002-m2';
import { M31720000003000 } from './migrations/0003-m3';
import { M41720000004000 } from './migrations/0004-m4';
import { M61720000005000 } from './migrations/0005-m6';

const entidades = [
  TenantSchema,
  UsuarioSchema,
  SessaoSchema,
  ConviteSchema,
  RedefinicaoSenhaSchema,
  SegredoSchema,
  SistemaAlvoSchema,
  CategoriaSchema,
  ChamadoSchema,
  MensagemSchema,
  AnexoSchema,
  EventoChamadoSchema,
  ExecucaoIASchema,
];
const migrations = [
  Init1720000000000,
  Auth1720000001000,
  M21720000002000,
  M31720000003000,
  M41720000004000,
  M61720000005000,
];

/**
 * DataSource da APLICAÇÃO (web + worker). Conecta com o role SEM BYPASSRLS.
 * Todo acesso a dados de negócio deve passar por `runInTenantContext`.
 */
export function criarAppDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    ...conexaoBase,
    username: credenciaisApp.username,
    password: credenciaisApp.password,
    entities: entidades,
    migrations,
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
  });
}

/**
 * DataSource ADMINISTRATIVO (migrations/tarefas). Conecta com o superuser do
 * container (BYPASSRLS). NUNCA usar para servir requisições da aplicação.
 */
export function criarAdminDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    ...conexaoBase,
    username: credenciaisAdmin.username,
    password: credenciaisAdmin.password,
    entities: entidades,
    migrations,
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
  });
}

// Singleton do DataSource da aplicação (sobrevive ao HMR do Next em dev).
const globalRef = globalThis as unknown as { __chamadosAppDataSource?: DataSource };

/** Retorna o DataSource da aplicação já inicializado (idempotente). */
export async function obterAppDataSource(): Promise<DataSource> {
  if (!globalRef.__chamadosAppDataSource) {
    globalRef.__chamadosAppDataSource = criarAppDataSource();
  }
  const ds = globalRef.__chamadosAppDataSource;
  if (!ds.isInitialized) {
    await ds.initialize();
  }
  return ds;
}
