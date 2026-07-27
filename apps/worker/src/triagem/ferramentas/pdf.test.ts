import { describe, it, expect } from 'vitest';
import { gerarPdfDeMarkdown } from './pdf';

/**
 * Template de PDF (D-027, neutro — sem branding de tenant por decisão do
 * usuário): geração real com capa/rodapé, gráficos vetoriais dos três tipos e a
 * spec de gráfico inválida virando erro corrigível pelo modelo.
 */

function contarPaginas(pdf: Buffer): number {
  return pdf.toString('latin1').split('/Type /Page').length - 1;
}

describe('gerarPdfDeMarkdown com template neutro (D-027)', () => {
  it('gera PDF com capa (título + data) e corpo', async () => {
    const pdf = await gerarPdfDeMarkdown('Relatório de Chamados', '# Resumo\n\nTexto do corpo.');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('sem título ainda gera capa slim e rodapé', async () => {
    const pdf = await gerarPdfDeMarkdown(null, 'Corpo simples.');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('desenha os três tipos de gráfico no mesmo documento', async () => {
    const grafico = (tipo: string, n: number) =>
      '```grafico\n' +
      JSON.stringify({
        tipo,
        titulo: `Gráfico ${tipo}`,
        dados: Array.from({ length: n }, (_, i) => ({
          rotulo: `Cat ${i + 1}`,
          valor: (i + 1) * 7,
        })),
      }) +
      '\n```\n';
    const md =
      '# Indicadores\n\n' +
      grafico('barras', 6) +
      '\nEvolução mensal:\n\n' +
      grafico('linhas', 12) +
      '\nDistribuição:\n\n' +
      grafico('pizza', 5);
    const pdf = await gerarPdfDeMarkdown('Relatório com gráficos', md);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // 3 gráficos de ~200pt cada + textos não cabem numa página só.
    expect(contarPaginas(pdf)).toBeGreaterThanOrEqual(2);
    expect(pdf.length).toBeGreaterThan(4000);
  });

  it('bloco ```grafico inválido falha com erro corrigível (grafico_invalido)', async () => {
    await expect(
      gerarPdfDeMarkdown('T', '```grafico\n{"tipo":"radar","dados":[]}\n```'),
    ).rejects.toThrow(/pdf_falhou:grafico_invalido/);
    await expect(gerarPdfDeMarkdown('T', '```grafico\nisso não é json\n```')).rejects.toThrow(
      /JSON malformado/,
    );
  });

  it('bloco de código comum continua sendo código (não gráfico)', async () => {
    const pdf = await gerarPdfDeMarkdown('T', '```sql\nSELECT 1;\n```\n\n```\nsem lang\n```');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('tabela, listas e blockquote seguem renderizando com o template', async () => {
    const md = [
      '## Tabela',
      '| Categoria | Total | % |',
      '|---|---|---|',
      '| Acesso | 42 | 35% |',
      '| Financeiro | 78 | 65% |',
      '',
      '- item um',
      '- item dois',
      '  1. sub ordenado',
      '',
      '> Observação em destaque.',
    ].join('\n');
    const pdf = await gerarPdfDeMarkdown('Misto', md);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('documento longo ganha múltiplas páginas com rodapé em todas', async () => {
    const md = Array.from({ length: 80 }, (_, i) => `Parágrafo ${i + 1} com texto corrido.`).join(
      '\n\n',
    );
    const pdf = await gerarPdfDeMarkdown('Longo', md);
    expect(contarPaginas(pdf)).toBeGreaterThanOrEqual(2);
  });
});
