'use client';

import { useRouter } from 'next/navigation';
import { TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Linha da tabela da fila clicável por inteiro (D-045). O LINK acessível é o
 * título (teclado, leitor de tela, abrir em nova aba); a linha só amplia a área
 * de clique para o mouse. Feito em JS — e não com o "link esticado" via
 * `position: relative` no `<tr>` — porque o suporte a `<tr>` como bloco de
 * contenção é irregular entre navegadores e, quando falha, o link esticado
 * cobriria a tabela inteira. Cliques em elementos interativos (link, botão) e
 * seleção de texto não navegam.
 */
export function LinhaClicavel({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <TableRow
      className={cn('cursor-pointer', className)}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        const alvo = e.target as HTMLElement;
        if (alvo.closest('a, button, input, select, textarea, [role="menuitem"]')) return;
        if (window.getSelection()?.toString()) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          window.open(href, '_blank', 'noopener');
          return;
        }
        router.push(href);
      }}
    >
      {children}
    </TableRow>
  );
}
