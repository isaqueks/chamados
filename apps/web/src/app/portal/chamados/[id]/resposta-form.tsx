'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/react';
import { toast } from 'sonner';
import { Paperclip, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RichTextEditor, docTemConteudo } from '@/components/editor';
import { acaoResponder, type EstadoChamado } from '../actions';

const INICIAL: EstadoChamado = {};

/** Compositor de resposta do cliente (specs/04 §4): rich text + anexos, sempre público. */
export function RespostaForm({ chamadoId }: { chamadoId: string }) {
  const [estado, acao, pendente] = useActionState(acaoResponder, INICIAL);
  const [chaveEditor, setChaveEditor] = useState(0);
  const [temConteudo, setTemConteudo] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sucessoTratado = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (estado.sucesso && estado.sucesso !== sucessoTratado.current) {
      sucessoTratado.current = estado.sucesso;
      toast.success('Resposta enviada.');
      formRef.current?.reset();
      setChaveEditor((k) => k + 1);
      setTemConteudo(false);
    }
  }, [estado.sucesso]);

  function aoMudar(doc: JSONContent) {
    setTemConteudo(docTemConteudo(doc));
  }

  return (
    <form ref={formRef} action={acao} className="flex flex-col gap-3">
      <input type="hidden" name="chamado_id" value={chamadoId} />

      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      <RichTextEditor
        key={chaveEditor}
        name="corpo"
        ariaLabel="Sua resposta"
        placeholder="Escreva sua resposta…"
        onChange={aoMudar}
      />

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="anexos"
          className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Paperclip className="size-4" />
          Anexar arquivos (opcional)
        </Label>
        <input
          id="anexos"
          name="anexos"
          type="file"
          multiple
          className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm hover:file:bg-muted"
        />
        <p className="text-xs text-muted-foreground">
          Imagens, PDF, texto/CSV, docx/xlsx ou zip — até 25 MB cada.
        </p>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={pendente || !temConteudo}>
          <Send />
          {pendente ? 'Enviando…' : 'Enviar resposta'}
        </Button>
      </div>
    </form>
  );
}
