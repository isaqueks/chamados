import {
  FolderGitIcon,
  GitMergeIcon,
  HistoryIcon,
  LayersIcon,
  ListTodoIcon,
  PlugIcon,
  SettingsIcon,
  StethoscopeIcon,
  TerminalSquareIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ContadoresSidebarDto } from '@comum/dto';

/**
 * Itens da sidebar (specs/forja/06 §1.1), na ordem da spec, mais Configurações
 * (globais, FJ-030 §2) depois de Conexão. `contador` diz o
 * que aparece ao lado do rótulo; `alerta` vira ponto vermelho (Conexão,
 * Diagnóstico). `/execucoes/:id` e `/execucoes/:id/aprovacao` ficam fora da
 * sidebar e ativam o item Fila.
 */
export interface ItemNav {
  href: string;
  rotulo: string;
  icone: LucideIcon;
  /** Prefixos que também deixam o item ativo. */
  ativoEm?: string[];
  contador?: (c: ContadoresSidebarDto) => number;
  alerta?: (c: ContadoresSidebarDto) => boolean;
}

export const ITENS_NAV: ItemNav[] = [
  {
    href: '/fila',
    rotulo: 'Fila',
    icone: ListTodoIcon,
    ativoEm: ['/execucoes'],
    contador: (c) => c.fila_em_voo,
  },
  { href: '/lotes', rotulo: 'Lotes', icone: LayersIcon, contador: (c) => c.lotes_ativos },
  {
    href: '/merge',
    rotulo: 'Fila de merge',
    icone: GitMergeIcon,
    contador: (c) => c.merge_na_fila + c.merge_a_publicar,
  },
  {
    href: '/terminal',
    rotulo: 'Terminal',
    icone: TerminalSquareIcon,
    contador: (c) => c.terminais_abertos,
  },
  { href: '/projetos', rotulo: 'Projetos', icone: FolderGitIcon },
  { href: '/conexao', rotulo: 'Conexão', icone: PlugIcon, alerta: (c) => c.conexao_com_erro },
  { href: '/configuracoes', rotulo: 'Configurações', icone: SettingsIcon },
  {
    href: '/diagnostico',
    rotulo: 'Diagnóstico',
    icone: StethoscopeIcon,
    alerta: (c) => c.diagnostico_bloqueante,
  },
  {
    href: '/historico',
    rotulo: 'Histórico',
    icone: HistoryIcon,
    contador: (c) => c.worktrees_orfas,
  },
];

export function itemAtivo(pathname: string, item: ItemNav): boolean {
  const prefixos = [item.href, ...(item.ativoEm ?? [])];
  return prefixos.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
