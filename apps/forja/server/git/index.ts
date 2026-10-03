/**
 * Git do app (specs/forja/01 §9, 03 §8, 04 §7): ponto de entrada do pacote.
 * O orquestrador (`server/dominio`) importa daqui, nunca dos arquivos internos.
 */
export * from './git';
export * from './worktrees';
export * from './checkpoint';
export * from './selos';
export * from './integracao';
