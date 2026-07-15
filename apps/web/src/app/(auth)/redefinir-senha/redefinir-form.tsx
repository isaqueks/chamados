'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoRedefinir, type EstadoRedefinir } from './actions';

const INICIAL: EstadoRedefinir = {};

export function RedefinirForm({ token }: { token: string }) {
  const [estado, acao, pendente] = useActionState(acaoRedefinir, INICIAL);

  if (estado.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success">
          <AlertDescription>
            Senha redefinida com sucesso. Todas as sessões anteriores foram encerradas.
          </AlertDescription>
        </Alert>
        <Link href="/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Ir para o login
        </Link>
      </div>
    );
  }

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="senha">Nova senha</Label>
        <Input
          id="senha"
          name="senha"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirma">Confirmar nova senha</Label>
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
        {pendente ? 'Salvando…' : 'Redefinir senha'}
      </Button>
    </form>
  );
}
