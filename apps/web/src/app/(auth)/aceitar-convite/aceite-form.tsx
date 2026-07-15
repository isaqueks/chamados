'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoAceitarConvite, type EstadoAceite } from './actions';

const INICIAL: EstadoAceite = {};

export function AceiteForm({ token, email }: { token: string; email: string }) {
  const [estado, acao, pendente] = useActionState(acaoAceitarConvite, INICIAL);

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" type="email" value={email} disabled readOnly />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="nome">Seu nome</Label>
        <Input id="nome" name="nome" type="text" required autoFocus />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="senha">Crie uma senha</Label>
        <Input
          id="senha"
          name="senha"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirma">Confirmar senha</Label>
        <Input
          id="confirma"
          name="confirma"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <Button type="submit" size="lg" disabled={pendente} className="w-full">
        {pendente ? 'Criando conta…' : 'Aceitar convite e entrar'}
      </Button>
    </form>
  );
}
