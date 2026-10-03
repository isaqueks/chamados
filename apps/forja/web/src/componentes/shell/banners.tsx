import { Link } from 'react-router';
import { AlertTriangleIcon, OctagonXIcon } from 'lucide-react';
import type { BannerDto } from '@comum/dto';
import { cn } from '@/lib/utils';

/**
 * Banners globais abaixo do cabeçalho (specs/forja/06 §1.3): empilháveis, um
 * por causa, sempre com a ação que resolve. "Sessão expirada" não é banner
 * (é a página cheia de `TelaSessaoExpirada`).
 */
export function Banners({ banners }: { banners: BannerDto[] }) {
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col">
      {banners.map((b) => {
        const Icone = b.nivel === 'erro' ? OctagonXIcon : AlertTriangleIcon;
        return (
          <div
            key={b.tipo}
            role={b.nivel === 'erro' ? 'alert' : 'status'}
            className={cn(
              'flex items-center gap-2 border-b px-4 py-2 text-sm',
              b.nivel === 'erro'
                ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
            )}
          >
            <Icone className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{b.mensagem}</span>
            {b.acao && (
              <Link to={b.acao.href} className="font-medium underline underline-offset-4">
                {b.acao.rotulo}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
