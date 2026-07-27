import { describe, it, expect } from 'vitest';
import { gerarPdfDeMarkdown, logoSuportado } from './pdf';

/**
 * Template de PDF com identidade visual (D-027): geração real com marca (cor,
 * nome, logo), gráficos vetoriais dos três tipos e os fallbacks (sem marca, logo
 * corrompido, spec de gráfico inválida → erro corrigível pelo modelo).
 */

// PNG 1×1 válido (para o pdfkit embutir de verdade no teste de logo).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MARCA = { nome: 'Top Veículos', corPrimaria: '#b91c1c', logo: null };

function contarPaginas(pdf: Buffer): number {
  return pdf.toString('latin1').split('/Type /Page').length - 1;
}

describe('gerarPdfDeMarkdown com identidade visual (D-027)', () => {
  it('gera PDF com marca completa (cor, nome e logo PNG real)', async () => {
    const pdf = await gerarPdfDeMarkdown('Relatório de Chamados', '# Resumo\n\nTexto do corpo.', {
      ...MARCA,
      logo: PNG_1PX,
    });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('sem marca, cai na paleta padrão e ainda gera capa/rodapé', async () => {
    const pdf = await gerarPdfDeMarkdown('Título', 'Corpo simples.');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('logo com magic de PNG mas corrompido não derruba a geração', async () => {
    const corrompido = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);
    const pdf = await gerarPdfDeMarkdown('Título', 'Corpo.', { ...MARCA, logo: corrompido });
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
    const pdf = await gerarPdfDeMarkdown('Relatório com gráficos', md, MARCA);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // 3 gráficos de ~200pt cada + textos não cabem numa página só.
    expect(contarPaginas(pdf)).toBeGreaterThanOrEqual(2);
    expect(pdf.length).toBeGreaterThan(4000);
  });

  it('bloco ```grafico inválido falha com erro corrigível (grafico_invalido)', async () => {
    await expect(
      gerarPdfDeMarkdown('T', '```grafico\n{"tipo":"radar","dados":[]}\n```', MARCA),
    ).rejects.toThrow(/pdf_falhou:grafico_invalido/);
    await expect(
      gerarPdfDeMarkdown('T', '```grafico\nisso não é json\n```', MARCA),
    ).rejects.toThrow(/JSON malformado/);
  });

  it('bloco de código comum continua sendo código (não gráfico)', async () => {
    const pdf = await gerarPdfDeMarkdown(
      'T',
      '```sql\nSELECT 1;\n```\n\n```\nsem lang\n```',
      MARCA,
    );
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
    const pdf = await gerarPdfDeMarkdown('Misto', md, MARCA);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('documento longo ganha múltiplas páginas com rodapé em todas', async () => {
    const md = Array.from({ length: 80 }, (_, i) => `Parágrafo ${i + 1} com texto corrido.`).join(
      '\n\n',
    );
    const pdf = await gerarPdfDeMarkdown('Longo', md, MARCA);
    const paginas = contarPaginas(pdf);
    expect(paginas).toBeGreaterThanOrEqual(2);
  });
});

describe('logoSuportado', () => {
  it('aceita PNG e JPEG, rejeita o resto (SVG, texto, vazio)', () => {
    expect(logoSuportado(PNG_1PX)).toBe(true);
    expect(logoSuportado(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe(true);
    expect(logoSuportado(Buffer.from('<svg xmlns="..."></svg>'))).toBe(false);
    expect(logoSuportado(Buffer.from('logo.png'))).toBe(false);
    expect(logoSuportado(Buffer.alloc(0))).toBe(false);
  });
});
