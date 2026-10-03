/**
 * `server/processos` (specs/forja/01 §3.2, §6.7, §6.8): supervisor dos filhos
 * (grupo próprio, escada de sinais, timeouts, registro de pid/pgid), leitura de
 * `/proc`, ambiente por allowlist, lock por `session_id` e o algoritmo de
 * reconciliação do boot. A persistência (etapa/sessao_terminal) é injetada.
 */
export * from './ambiente';
export * from './proc-linux';
export * from './supervisor';
export * from './lock-sessao';
export * from './reconciliacao';
export * from './usuario';
