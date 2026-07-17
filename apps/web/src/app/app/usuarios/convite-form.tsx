'use client';

import { useActionState } from 'react';
import { Papel } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ROTULO_PAPEL } from '@/lib/rotulos';
import { acaoCriarConvite, type EstadoConvite } from './actions';

const INICIAL: EstadoConvite = {};
const OPCOES: Papel[] = [Papel.cliente, Papel.operador, Papel.admin];

export function ConviteForm() {
  const [estado, acao, pendente] = useActionState(acaoCriarConvite, INICIAL);

  return (
    <form action={acao} className="flex flex-col gap-4">
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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex max-w-sm flex-1 flex-col gap-2">
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" name="email" type="email" placeholder="pessoa@empresa.com" required />
        </div>
        <div className="flex flex-col gap-2 sm:w-44">
          <Label htmlFor="papel">Papel</Label>
          <select
            id="papel"
            name="papel"
            defaultValue={Papel.cliente}
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            {OPCOES.map((p) => (
              <option key={p} value={p}>
                {ROTULO_PAPEL[p]}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pendente} size="lg">
          {pendente ? 'Enviando…' : 'Convidar'}
        </Button>
      </div>
    </form>
  );
}
