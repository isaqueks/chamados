/**
 * Verificação (specs/forja/03 §5; FJ-032): a Forja NÃO executa comandos do
 * projeto — quem roda os checks é o agente. Aqui ficam o cálculo do nível ⚙
 * (o que o revisor relatou × o que o stream mostrou), a coleta dos prints
 * antes/depois feitos pelo agente (FJ-026, FJ-030 §3) e utilitários de
 * processo/`bwrap` que sobraram.
 */
export * from './processo-grupo';
export * from './niveis';
export * from './evidencias';
export * from './confinamento-bwrap';
