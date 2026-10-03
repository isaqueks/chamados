import type { ConexaoDto, ProjetoResumoDto } from '@comum/dto';

/**
 * Onboarding em 2 passos (FJ-030 §5): no primeiro acesso — sem conexão ou sem
 * projeto — a Fila cede lugar ao assistente Conexão → Projeto. Só a Fila
 * redireciona: quem abre Diagnóstico, Conexão ou Configurações por link direto
 * chega lá (o assistente não prende ninguém).
 */

export const ROTA_ONBOARDING = '/comecar';

export type PassoOnboarding = 'conexao' | 'projeto';

/** `null` enquanto as duas listas não chegaram (não decide no escuro). */
export function precisaOnboarding(
  conexoes: readonly ConexaoDto[] | undefined,
  projetos: readonly ProjetoResumoDto[] | undefined,
): boolean | null {
  if (!conexoes || !projetos) return null;
  return conexoes.length === 0 || projetos.length === 0;
}

/** Com conexão já salva e funcionando, o assistente começa no passo Projeto. */
export function passoInicial(conexoes: readonly ConexaoDto[]): PassoOnboarding {
  return conexoes.some((c) => c.estado === 'ok') ? 'projeto' : 'conexao';
}

export function deveIrAoOnboarding(pathname: string, precisa: boolean | null): boolean {
  return precisa === true && (pathname === '/' || pathname === '/fila');
}
