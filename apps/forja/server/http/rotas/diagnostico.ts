import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas do Diagnóstico (specs/forja/06 §4.10; smoke de compatibilidade em 01 §7).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasDiagnostico = {
  diagnostico_obter: viaFachada('diagnostico_obter'),
  diagnostico_rodar: viaFachada('diagnostico_rodar'),
  diagnostico_aceitar_versao_cli: viaFachada('diagnostico_aceitar_versao_cli'),
} satisfies Pick<
  HandlersRotas,
  'diagnostico_obter' | 'diagnostico_rodar' | 'diagnostico_aceitar_versao_cli'
>;
