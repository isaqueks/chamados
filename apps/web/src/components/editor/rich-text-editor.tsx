'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { criarExtensoes } from './extensoes';
import { classesConteudoRico } from './prose';
import { EditorToolbar } from './editor-toolbar';

const DOC_VAZIO: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Lê um arquivo de imagem como data URL (o servidor materializa como Anexo inline). */
function lerComoDataURL(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(arquivo);
  });
}

/** Insere imagens (colar/arrastar/botão) como nós `image` com `src=data:` (specs/04 §5). */
async function inserirImagens(editor: Editor | null, arquivos: File[]): Promise<void> {
  if (!editor) return;
  for (const arquivo of arquivos) {
    if (!arquivo.type.startsWith('image/')) continue;
    try {
      const src = await lerComoDataURL(arquivo);
      editor.chain().focus().setImage({ src }).run();
    } catch {
      // arquivo ilegível: ignora silenciosamente (o servidor valida por magic bytes).
    }
  }
}

/** Há texto ou imagem real no documento? (validação client-side antes de enviar). */
export function docTemConteudo(doc?: JSONContent | null): boolean {
  if (!doc) return false;
  let achou = false;
  const visitar = (no?: JSONContent): void => {
    if (!no || achou) return;
    if (no.type === 'text' && (no.text?.trim().length ?? 0) > 0) achou = true;
    else if (no.type === 'image') achou = true;
    else no.content?.forEach(visitar);
  };
  visitar(doc);
  return achou;
}

export interface RichTextEditorProps {
  /** Documento TipTap inicial (JSON). Ausente = editor vazio. */
  value?: JSONContent;
  /** Notifica cada mudança com o JSON atual (compatível com o pipeline server-side). */
  onChange?: (doc: JSONContent) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Se informado, emite um `<input type="hidden">` com o JSON para envio em `<form action>`. */
  name?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Editor rich text compartilhado (specs/04 §5, specs/08 D-009). Client component
 * com TipTap (starter-kit + link + image + placeholder). A saída é o JSON TipTap,
 * alinhado à allowlist do pipeline `packages/db/src/chamados/rich-text.ts`. API por
 * props para o portal do cliente E o painel operador reutilizarem.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  name,
  ariaLabel,
  className,
}: RichTextEditorProps) {
  const [docJson, setDocJson] = useState<JSONContent>(value ?? DOC_VAZIO);
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: criarExtensoes(placeholder),
    content: value ?? '',
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel ?? 'Editor de texto',
        class: cn('tiptap-conteudo min-h-28 px-3 py-2 outline-none', classesConteudoRico),
      },
      handlePaste: (_view, event) => {
        const arquivos = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (arquivos.length === 0) return false;
        event.preventDefault();
        void inserirImagens(editorRef.current, arquivos);
        return true;
      },
      handleDrop: (_view, event) => {
        const arquivos = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (arquivos.length === 0) return false;
        event.preventDefault();
        void inserirImagens(editorRef.current, arquivos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const json = e.getJSON();
      setDocJson(json);
      onChange?.(json);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      className={cn(
        'rte overflow-hidden rounded-lg border border-input bg-transparent shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        disabled && 'pointer-events-none opacity-60',
        className,
      )}
    >
      <EditorToolbar
        editor={editor}
        disabled={disabled}
        onSelecionarImagens={(arquivos) => void inserirImagens(editor, arquivos)}
      />
      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div className={cn('min-h-28 px-3 py-2', classesConteudoRico)} aria-hidden />
      )}
      {name ? <input type="hidden" name={name} value={JSON.stringify(docJson)} /> : null}
      <style
        dangerouslySetInnerHTML={{
          __html:
            '.rte .tiptap-conteudo p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:var(--muted-foreground);float:left;height:0;pointer-events:none;}',
        }}
      />
    </div>
  );
}
