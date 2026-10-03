import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas das Configurações globais (FJ-030 §2: modelos, cota, concorrência,
 * limites e gates numa tela só, com "Restaurar padrões").
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasConfiguracoes = {
  configuracoes_obter: viaFachada('configuracoes_obter'),
  configuracoes_gravar: viaFachada('configuracoes_gravar'),
  configuracoes_restaurar: viaFachada('configuracoes_restaurar'),
} satisfies Pick<
  HandlersRotas,
  'configuracoes_obter' | 'configuracoes_gravar' | 'configuracoes_restaurar'
>;
