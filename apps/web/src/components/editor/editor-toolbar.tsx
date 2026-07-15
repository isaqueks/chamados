'use client';

import { useRef, useState } from 'react';
import { type Editor, useEditorState } from '@tiptap/react';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Code,
  Link2,
  ImageIcon,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const FLAGS_VAZIAS = {
  bold: false,
  italic: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  codeBlock: false,
  link: false,
};

/** Barra mínima e limpa (specs/08 §4.1): negrito, itálico, listas, citação, código, link, imagem. */
export function EditorToolbar({
  editor,
  disabled,
  onSelecionarImagens,
}: {
  editor: Editor | null;
  disabled?: boolean;
  onSelecionarImagens: (arquivos: File[]) => void;
}) {
  const flags =
    useEditorState({
      editor,
      selector: ({ editor: e }) => ({
        bold: e?.isActive('bold') ?? false,
        italic: e?.isActive('italic') ?? false,
        bulletList: e?.isActive('bulletList') ?? false,
        orderedList: e?.isActive('orderedList') ?? false,
        blockquote: e?.isActive('blockquote') ?? false,
        codeBlock: e?.isActive('codeBlock') ?? false,
        link: e?.isActive('link') ?? false,
      }),
    }) ?? FLAGS_VAZIAS;

  const inputArquivoRef = useRef<HTMLInputElement>(null);
  const [linkAberto, setLinkAberto] = useState(false);
  const [urlLink, setUrlLink] = useState('');
  const inativo = disabled || !editor;

  function abrirLink() {
    if (!editor) return;
    setUrlLink(String(editor.getAttributes('link').href ?? ''));
    setLinkAberto(true);
  }

  function aplicarLink() {
    if (!editor) return;
    const href = urlLink.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (href === '') chain.unsetLink().run();
    else chain.setLink({ href }).run();
    setLinkAberto(false);
    setUrlLink('');
  }

  function removerLink() {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkAberto(false);
    setUrlLink('');
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex flex-col border-b border-border bg-muted/30">
        <div className="flex flex-wrap items-center gap-0.5 p-1">
          <BotaoFerramenta
            rotulo="Negrito"
            ativo={flags.bold}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Itálico"
            ativo={flags.italic}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </BotaoFerramenta>

          <Separador />

          <BotaoFerramenta
            rotulo="Lista com marcadores"
            ativo={flags.bulletList}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <List />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Lista numerada"
            ativo={flags.orderedList}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Citação"
            ativo={flags.blockquote}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            <Quote />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Bloco de código"
            ativo={flags.codeBlock}
            disabled={inativo}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            <Code />
          </BotaoFerramenta>

          <Separador />

          <BotaoFerramenta
            rotulo="Inserir link"
            ativo={flags.link || linkAberto}
            disabled={inativo}
            onClick={abrirLink}
          >
            <Link2 />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Inserir imagem"
            disabled={inativo}
            onClick={() => inputArquivoRef.current?.click()}
          >
            <ImageIcon />
          </BotaoFerramenta>

          <input
            ref={inputArquivoRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const arquivos = Array.from(e.target.files ?? []);
              if (arquivos.length > 0) onSelecionarImagens(arquivos);
              e.target.value = '';
            }}
          />
        </div>

        {linkAberto && (
          <div className="flex items-center gap-1.5 border-t border-border bg-muted/40 p-1.5">
            <Input
              autoFocus
              value={urlLink}
              onChange={(e) => setUrlLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  aplicarLink();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkAberto(false);
                }
              }}
              placeholder="https://exemplo.com"
              className="h-7 flex-1 text-sm"
              aria-label="Endereço do link"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="default"
              onClick={aplicarLink}
              aria-label="Aplicar link"
            >
              <Check />
            </Button>
            {flags.link && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={removerLink}
                className="text-muted-foreground"
              >
                Remover
              </Button>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => setLinkAberto(false)}
              aria-label="Cancelar"
            >
              <X />
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function BotaoFerramenta({
  rotulo,
  ativo,
  disabled,
  onClick,
  children,
}: {
  rotulo: string;
  ativo?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={ativo ? 'secondary' : 'ghost'}
            aria-label={rotulo}
            aria-pressed={ativo}
            disabled={disabled}
            // Preserva a seleção do editor ao clicar na barra.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{rotulo}</TooltipContent>
    </Tooltip>
  );
}

function Separador() {
  return <span className={cn('mx-0.5 h-5 w-px bg-border')} aria-hidden />;
}
