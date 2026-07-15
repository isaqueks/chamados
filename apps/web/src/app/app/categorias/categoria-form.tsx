'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoCriarCategoria, type EstadoCategoria } from './actions';

const INICIAL: EstadoCategoria = {};

export function CategoriaForm() {
  const [estado, acao, pendente] = useActionState(acaoCriarCategoria, INICIAL);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (estado.sucesso) formRef.current?.reset();
  }, [estado.sucesso]);

  return (
    <form ref={formRef} action={acao} className="flex flex-col gap-4">
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
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="nome">Nome</Label>
          <Input id="nome" name="nome" placeholder="Financeiro, RH…" required minLength={2} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="descricao">Descrição (opcional)</Label>
          <Input id="descricao" name="descricao" />
        </div>
        <Button type="submit" disabled={pendente} size="lg">
          {pendente ? 'Criando…' : 'Adicionar'}
        </Button>
      </div>
    </form>
  );
}
