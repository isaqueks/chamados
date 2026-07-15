'use client';

import { useActionState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoEnviarLogo, acaoRemoverLogo, type EstadoConfig } from './actions';

const INICIAL: EstadoConfig = {};

interface Props {
  variante: 'light' | 'dark';
  rotulo: string;
  urlAtual: string | null;
}

export function LogoForm({ variante, rotulo, urlAtual }: Props) {
  const [estado, acao, pendente] = useActionState(acaoEnviarLogo, INICIAL);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <Label>{rotulo}</Label>
        {urlAtual && (
          <form action={acaoRemoverLogo}>
            <input type="hidden" name="variante" value={variante} />
            <Button type="submit" variant="ghost" size="xs" aria-label={`Remover logo ${rotulo}`}>
              <Trash2 className="size-3.5" />
              Remover
            </Button>
          </form>
        )}
      </div>

      <div
        className={`flex h-20 items-center justify-center rounded-md border border-dashed ${
          variante === 'dark' ? 'bg-neutral-900' : 'bg-neutral-50'
        }`}
      >
        {urlAtual ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={urlAtual}
            alt={`Logo ${rotulo}`}
            className="max-h-16 max-w-[80%] object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">Nenhum logo</span>
        )}
      </div>

      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}
      {estado.sucesso && (
        <Alert variant="success">
          <AlertDescription>{estado.sucesso}</AlertDescription>
        </Alert>
      )}

      <form action={acao} className="flex flex-col gap-2">
        <input type="hidden" name="variante" value={variante} />
        <input
          type="file"
          name="arquivo"
          accept="image/png,image/jpeg,image/webp"
          required
          className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1 file:text-sm file:font-medium"
        />
        <div>
          <Button type="submit" variant="outline" size="sm" disabled={pendente}>
            {pendente ? 'Enviando…' : 'Enviar imagem'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPEG ou WEBP, até 1 MB.</p>
      </form>
    </div>
  );
}
