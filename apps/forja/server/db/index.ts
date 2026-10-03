/**
 * Persistência local da Forja (specs/forja/02): SQLite via TypeORM +
 * better-sqlite3, entidades por `EntitySchema`, migrations escritas à mão.
 *
 * Uso no boot (01 §4.1): `const banco = await abrirBanco(config)` — cria o
 * diretório de dados, faz `VACUUM INTO` de backup se houver migration
 * pendente, migra e devolve o `BancoForja`. Todo acesso depois disso é
 * `banco.transacao(async (r) => …)` com os repositórios de `r`.
 */
export { BancoForja } from './banco';
export {
  abrirBanco,
  caminhoBanco,
  copiarParaBackup,
  criarDataSource,
  migrarComBackup,
  reverterUltima,
  BACKUPS_MANTIDOS,
  DIR_BACKUPS,
  NOME_ARQUIVO_BANCO,
  type OpcoesAbrirBanco,
  type ResultadoMigracao,
} from './data-source';
export * from './entidades';
export * from './erros';
export { novoId, relogioSistema, type Relogio } from './ids';
export * from './json';
export * from './persistencia-eventos';
export * from './repositorios';
