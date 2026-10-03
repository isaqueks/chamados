/**
 * Domínio PURO do pipeline (specs/forja/03; 04 §6–§8): máquina de estados,
 * gates, ciclos, lote/semáforos, freio de cota e regras de contrato/relatório.
 * Nada aqui faz I/O: o orquestrador (R3) lê o SQLite/git, chama estas funções
 * e aplica a decisão (estado + evento na mesma transação).
 */
export * from './maquina-execucao';
export * from './gates';
export * from './ciclos';
export * from './lote';
export * from './freio-cota';
export * from './regras-contratos';
export * from './regras-relatorio';
export * from './texto';

/*
 * Camada com I/O (R3-B): orquestrador, etapas, fila de merge, outbox,
 * retenção e a fachada tipada que as rotas HTTP chamam. Dependem do SQLite,
 * do git e dos runners — todos injetados (`DepsOrquestrador`).
 */
export * from './nucleo';
export * from './aplicacao-resultados';
export * from './etapas';
export * from './fila-merge';
export * from './outbox';
export * from './retencao';
export * from './orquestrador';
export * from './servicos';
