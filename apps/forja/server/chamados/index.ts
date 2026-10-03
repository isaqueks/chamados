/**
 * `server/chamados` — integração da Forja com o Chamados (specs/forja/07): a
 * conexão e a sessão, a fila e as pré-condições do G0, os sinais e as notas da
 * IA do servidor, o polling dos chamados em voo, a cadeia de status, o
 * validador de linguagem, o detector de segredos, os textos que a Forja
 * escreve e a execução de cada passo do outbox. A ligação com o SQLite, a
 * máquina da execução e as rotas HTTP é da R3: aqui tudo recebe as
 * dependências por injeção (`OperacoesChamados`, `PersistenciaConexao`,
 * `Segredos`, `DependenciasPolling`).
 */
export * from './tipos';
export * from './normalizacao';
export * from './conexao';
export * from './fila';
export * from './notas-ia';
export * from './sinais';
export * from './polling';
export * from './cadeia-status';
export * from './validador-linguagem';
export * from './detector-segredos';
export * from './notas';
export * from './outbox-passos';
