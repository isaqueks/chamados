'use client';

import { useActionState, useState } from 'react';
import { Pencil, Trash2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoEditarCategoria, acaoRemoverCategoria, type EstadoCategoria } from './actions';

const INICIAL: EstadoCategoria = {};

export interface CategoriaView {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  geral: boolean;
}

export function CategoriaLinha({ categoria }: { categoria: CategoriaView }) {
  const [editando, setEditando] = useState(false);
  const [estado, acao, pendente] = useActionState(acaoEditarCategoria, INICIAL);

  if (categoria.geral) {
    return (
      <div className="flex items-center gap-3 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 font-medium">
            {categoria.nome}
            <Badge variant="muted" aria-label="Categoria protegida">
              <Lock className="size-3" />
              Padrão
            </Badge>
          </span>
          {categoria.descricao && (
            <span className="text-xs text-muted-foreground">{categoria.descricao}</span>
          )}
        </div>
      </div>
    );
  }

  if (editando) {
    return (
      <form action={acao} className="flex flex-col gap-2 py-3">
        <input type="hidden" name="id" value={categoria.id} />
        {estado.erro && (
          <Alert variant="destructive">
            <AlertDescription>{estado.erro}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input name="nome" defaultValue={categoria.nome} required minLength={2} />
          <Input
            name="descricao"
            defaultValue={categoria.descricao ?? ''}
            placeholder="Descrição"
          />
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <input
              type="checkbox"
              name="ativo"
              defaultChecked={categoria.ativo}
              className="size-4 rounded border-input"
            />
            Ativa
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pendente}>
              {pendente ? '…' : 'Salvar'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 font-medium">
          {categoria.nome}
          {!categoria.ativo && <Badge variant="muted">Inativa</Badge>}
        </span>
        {categoria.descricao && (
          <span className="text-xs text-muted-foreground">{categoria.descricao}</span>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={() => setEditando(true)}>
        <Pencil className="size-3.5" />
        Editar
      </Button>
      <form action={acaoRemoverCategoria}>
        <input type="hidden" name="id" value={categoria.id} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          aria-label={`Remover categoria ${categoria.nome}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
