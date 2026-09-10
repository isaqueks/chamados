import { describe, it, expect } from 'vitest';
import { docParaMarkdown } from './markdown-saida';
import { markdownParaDoc } from './markdown';

/** Saída rica da API (specs/11 §1.5, D-035): doc → markdown. */
describe('docParaMarkdown', () => {
  it('faz a ida e volta de um markdown típico', () => {
    const md = [
      '# Título',
      '',
      'Texto com **negrito**, *itálico* e `código`.',
      '',
      '- item um',
      '- item dois',
      '',
      '1. primeiro',
      '2. segundo',
      '',
      '> citação',
      '',
      '```',
      'const x = 1;',
      '```',
    ].join('\n');
    expect(docParaMarkdown(markdownParaDoc(md))).toBe(md);
  });

  it('reescreve a URL da imagem inline pela opção urlImagem', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Veja: ' },
            { type: 'image', attrs: { src: '/api/anexos/abc', alt: 'tela' } },
          ],
        },
      ],
    };
    expect(
      docParaMarkdown(doc, { urlImagem: (s) => s.replace('/api/anexos/', '/api/v1/anexos/') }),
    ).toBe('Veja: ![tela](/api/v1/anexos/abc)');
  });

  it('renderiza tabela GFM com cabeçalho e escapa o pipe', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x|y' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(docParaMarkdown(doc)).toBe('| A | B |\n| --- | --- |\n| x\\|y | 2 |');
  });

  it('escapa marcadores no texto e ignora nó desconhecido', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'preço 2*3_4' }] },
        { type: 'iframe', attrs: { src: 'x' } },
      ],
    };
    expect(docParaMarkdown(doc)).toBe('preço 2\\*3\\_4');
    expect(docParaMarkdown(null)).toBe('');
  });
});
