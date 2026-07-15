import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { conexaoBase, credenciaisAdmin, credenciaisApp } from './config';
import { TenantSchema } from './entities/tenant';
import { UsuarioSchema } from './entities/usuario';
import { Init1720000000000 } from './migrations/0000-init';

const entidades = [TenantSchema, UsuarioSchema];
const migrations = [Init1720000000000];

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
