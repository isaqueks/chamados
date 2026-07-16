'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import type { JSONContent } from '@tiptap/react';
import { Natureza, Prioridade } from '@chamados/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { ROTULO_PRIORIDADE } from '@/lib/rotulos';
import { RichTextEditor, docTemConteudo } from '@/components/editor';
import { acaoCriarChamado, type EstadoChamado } from '../chamados/actions';

const INICIAL: EstadoChamado = {};

const SELECT_CLS =
  'flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

const NATUREZAS: { valor: Natureza; titulo: string; descricao: string }[] = [
  {
    valor: Natureza.problema,
    titulo: 'Problema',
    descricao: 'Algo não está funcionando como deveria.',
  },
  {
    valor: Natureza.alteracao,
    titulo: 'Alteração',
    descricao: 'Quero solicitar uma mudança ou melhoria.',
  },
  {
    valor: Natureza.duvida,
    titulo: 'Dúvida',
    descricao: 'Quero entender como algo funciona.',
  },
];

export function ChamadoNovoForm({
  sistemas,
  tituloInicial = '',
}: {
  sistemas: { id: string; nome: string }[];
  tituloInicial?: string;
}) {
  const [estado, acao, pendente] = useActionState(acaoCriarChamado, INICIAL);
  const [titulo, setTitulo] = useState(tituloInicial);
  const [temDescricao, setTemDescricao] = useState(false);

  const mostrarSistema = sistemas.length > 1;
  const podeEnviar = titulo.trim().length >= 3 && temDescricao;

  function aoMudarDescricao(doc: JSONContent) {
    setTemDescricao(docTemConteudo(doc));
  }

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      {mostrarSistema && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="sistema_alvo_id">Sistema</Label>
          <select
            id="sistema_alvo_id"
            name="sistema_alvo_id"
            className={SELECT_CLS}
            required
            defaultValue=""
          >
            <option value="" disabled>
              Selecione o sistema
            </option>
            {sistemas.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Qual é a natureza do chamado?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {NATUREZAS.map((n, i) => (
            <label
              key={n.valor}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-input p-3 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5 hover:bg-muted/50"
            >
              <input
                type="radio"
                name="natureza"
                value={n.valor}
                defaultChecked={i === 0}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{n.titulo}</span>
                <span className="text-xs text-muted-foreground">{n.descricao}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="titulo">Título</Label>
        <Input
          id="titulo"
          name="titulo"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          placeholder="Ex.: Não consigo emitir a segunda via do boleto"
          required
          minLength={3}
          maxLength={160}
          autoComplete="off"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Descrição</Label>
        <RichTextEditor
          name="descricao"
          ariaLabel="Descrição do chamado"
          placeholder="Descreva com detalhes. Você pode colar ou arrastar imagens (prints)."
          onChange={aoMudarDescricao}
        />
        <p className="text-xs text-muted-foreground">
          Dica: colar um print ajuda muito a entender o problema.
        </p>
      </div>

      <details className="group rounded-lg border border-input">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          Opções avançadas
          <span className="text-xs transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="flex flex-col gap-2 border-t border-input p-3">
          <Label htmlFor="prioridade">Prioridade (opcional)</Label>
          <select
            id="prioridade"
            name="prioridade"
            className={SELECT_CLS}
            defaultValue={Prioridade.media}
          >
            {Object.values(Prioridade).map((p) => (
              <option key={p} value={p}>
                {ROTULO_PRIORIDADE[p]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Não tem certeza? Deixe como está — nossa assistente ajusta a prioridade na triagem.
          </p>
        </div>
      </details>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Link href="/portal" className={cn(buttonVariants({ variant: 'ghost' }))}>
          Cancelar
        </Link>
        <Button type="submit" size="lg" disabled={pendente || !podeEnviar}>
          {pendente ? 'Abrindo…' : 'Abrir chamado'}
        </Button>
      </div>
    </form>
  );
}
