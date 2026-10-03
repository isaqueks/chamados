import { KeyRoundIcon } from 'lucide-react';

/**
 * "Sessão expirada" em página cheia (specs/forja/06 §1.3): o servidor reiniciou
 * e o cookie do boot anterior não vale. Sem campo de token na página — o único
 * caminho é o link impresso no terminal onde a Forja subiu (05 §7.1).
 */
export function TelaSessaoExpirada() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted">
          <KeyRoundIcon className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">Sessão expirada</h1>
        <p className="text-sm text-muted-foreground">
          A Forja foi reiniciada ou este link não vale mais. Reabra pelo endereço impresso no
          terminal onde a Forja subiu (<code className="font-mono text-xs">npm run forja</code>).
        </p>
      </div>
    </div>
  );
}
