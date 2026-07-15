'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/react';
import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { VisibilidadeMensagem } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RichTextEditor, docTemConteudo } from '@/components/editor';
import { acaoResponder, type EstadoChamado } from '../actions';

const INICIAL: EstadoChamado = {};

/**
 * Compositor da timeline (specs/04 §6, specs/08 §4.3). Editor rico (TipTap)
 * compartilhado com o portal do cliente (`@/components/editor`) — o pipeline
 * server-side (sanitização, anexos inline) é o mesmo. Operador/admin alternam
 * Pública/Interna com DEFAULT INTERNA (reduz risco de vazamento — specs/08).
 * Cliente sempre publica.
 */
export function RespostaForm({
  chamadoId,
  podeInterna,
}: {
  chamadoId: string;
  podeInterna: boolean;
}) {
  const [estado, acao, pendente] = useActionState(acaoResponder, INICIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const [interna, setInterna] = useState(podeInterna); // default interna p/ equipe
  const [chaveEditor, setChaveEditor] = useState(0);
  const [temConteudo, setTemConteudo] = useState(false);

  useEffect(() => {
    if (estado.sucesso) {
      toast.success(estado.sucesso);
      formRef.current?.reset();
      setInterna(podeInterna);
      setChaveEditor((k) => k + 1);
      setTemConteudo(false);
    } else if (estado.erro) {
      toast.error(estado.erro);
    }
  }, [estado, podeInterna]);

  function aoMudar(doc: JSONContent) {
    setTemConteudo(docTemConteudo(doc));
  }

  return (
    <form ref={formRef} action={acao} className="flex flex-col gap-3">
      <input type="hidden" name="chamado_id" value={chamadoId} />
      <input
        type="hidden"
        name="visibilidade"
        value={interna ? VisibilidadeMensagem.interna : VisibilidadeMensagem.publica}
      />

      {podeInterna && (
        <div
          role="radiogroup"
          aria-label="Visibilidade da mensagem"
          className="inline-flex w-fit rounded-lg border bg-muted/40 p-0.5 text-sm"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!interna}
            onClick={() => setInterna(false)}
            className={cn(
              'rounded-md px-3 py-1 font-medium transition-colors',
              !interna
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Pública
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={interna}
            onClick={() => setInterna(true)}
            className={cn(
              'rounded-md px-3 py-1 font-medium transition-colors',
              interna
                ? 'bg-amber-100 text-amber-900 shadow-sm dark:bg-amber-950/60 dark:text-amber-200'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Nota interna
          </button>
        </div>
      )}

      <RichTextEditor
        key={chaveEditor}
        name="corpo"
        ariaLabel={podeInterna ? 'Resposta ou nota interna' : 'Sua mensagem'}
        placeholder={
          podeInterna
            ? 'Escreva uma resposta pública ao cliente ou uma nota interna…'
            : 'Escreva sua mensagem…'
        }
        onChange={aoMudar}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Paperclip className="size-4" />
          <span>Anexos</span>
          <input
            name="anexos"
            type="file"
            multiple
            className="text-xs file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-xs"
          />
        </label>
        <Button type="submit" disabled={pendente || !temConteudo}>
          {pendente ? 'Enviando…' : interna && podeInterna ? 'Registrar nota' : 'Enviar'}
        </Button>
      </div>
      {podeInterna && (
        <p className="text-xs text-muted-foreground">
          {interna
            ? 'Nota interna: visível apenas para a equipe. O cliente nunca a vê.'
            : 'Mensagem pública: será visível ao cliente na timeline.'}
        </p>
      )}
    </form>
  );
}
