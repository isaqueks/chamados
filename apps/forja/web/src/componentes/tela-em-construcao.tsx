import type { ReactNode } from 'react';
import { ConstructionIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';

/**
 * Placeholder das telas do scaffold (R1-B). Cada tela mostra o título, a
 * pergunta que responde (06 §2) e a seção da spec que a define — R4 troca por
 * implementação real.
 */
export function TelaEmConstrucao({
  titulo,
  pergunta,
  spec,
  children,
}: {
  titulo: string;
  pergunta: string;
  spec: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{titulo}</h1>
        <p className="text-sm text-muted-foreground">{pergunta}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ConstructionIcon className="size-4 text-muted-foreground" aria-hidden />
            Em construção
          </CardTitle>
          <CardDescription>
            Esta tela segue <code className="font-mono text-xs">{spec}</code>.
          </CardDescription>
        </CardHeader>
        {children && <CardContent>{children}</CardContent>}
      </Card>
    </div>
  );
}
