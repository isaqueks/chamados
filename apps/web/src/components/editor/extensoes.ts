import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import type { Extensions } from '@tiptap/react';

/**
 * Extensões do editor rich text (specs/04 §5). Alinhadas 1:1 à allowlist do
 * pipeline server-side (`packages/db/src/chamados/rich-text.ts`):
 *
 *  - Nós: doc, paragraph, text, heading (h1–h3), bulletList, orderedList,
 *    listItem, codeBlock, blockquote, horizontalRule, hardBreak, image.
 *  - Marcas: bold, italic, strike, underline, code, link.
 *
 * O StarterKit v3 já traz `link` e `underline`; desligamos o `link` embutido para
 * usar a extensão dedicada (href seguro + toolbar). As imagens aceitam `data:`
 * (colar/arrastar) porque o servidor as materializa como `Anexo` inline antes de
 * sanitizar — nunca guardamos base64 no HTML final.
 */
export function criarExtensoes(placeholder?: string): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    Image.configure({ allowBase64: true }),
    Placeholder.configure({ placeholder: placeholder ?? 'Escreva aqui…' }),
  ];
}
