/**
 * Runner da CLI do Claude (specs/forja/01 §6–§7; 04 §3–§4, §9). Porta única do
 * orquestrador para agentes: perfis (flags) → arquivos gerados → prompts →
 * `RunnerCli.iniciar` → eventos normalizados + classificação do fim.
 */
export * from './perfis';
export * from './settings-gerados';
export * from './prompts';
export * from './stream';
export * from './validacao-init';
export * from './telemetria';
export * from './lock-sessoes';
export * from './runner';
export * from './retomada';
export * from './compat';
