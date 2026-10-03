/**
 * `server/eventos` (specs/forja/01 §8, 02 §4.8): barramento (seq, anel quente,
 * clientes com buffer em anel e `sistema.recarregar`), contrato da persistência
 * append-only, normalizador (payload enxuto + redação) e gravador do bruto
 * (`etapas/<n>/eventos.jsonl`).
 */
export * from './anel';
export * from './barramento';
export * from './persistencia';
export * from './normalizador';
export * from './gravador-bruto';
