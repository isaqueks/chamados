import { describe, it, expect } from 'vitest';
import { criarFerramentaArtefatos, sanitizarNomeArtefato } from './artefatos';
import { gerarPdfDeMarkdown } from './pdf';
import { ferramentasConfig } from './config';

/**
 * Artefatos entregáveis (D-026): sanitização de nome, validação de formato/
 * conteúdo, tetos por execução, substituição por nome repetido e a geração real
 * de PDF a partir de markdown (pdfkit, sem rede).
 */

const registrarNoop = (): void => {};

describe('sanitizarNomeArtefato (D-026)', () => {
  it('remove diretórios e caracteres de controle; força a extensão do formato', () => {
    expect(sanitizarNomeArtefato('../../etc/passwd', 'txt')).toBe('_.._etc_passwd.txt');
    expect(sanitizarNomeArtefato('rel\x00atorio', 'pdf')).toBe('relatorio.pdf');
    expect(sanitizarNomeArtefato('relatorio.PDF', 'pdf')).toBe('relatorio.pdf');
    expect(sanitizarNomeArtefato('dados.csv', 'csv')).toBe('dados.csv');
  });
  it('nome vazio/só pontos vira "artefato.<formato>"', () => {
    expect(sanitizarNomeArtefato('', 'pdf')).toBe('artefato.pdf');
    expect(sanitizarNomeArtefato('...', 'csv')).toBe('artefato.csv');
  });
});

describe('artefato_gerar (D-026)', () => {
  it('gera um txt e o coleta como ArquivoUpload', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    const r = await f.gerar({
      nome_arquivo: 'notas.txt',
      formato: 'txt',
      conteudo: 'linha 1\nlinha 2 com acentuação: ção, é, ã',
    });
    expect(r).toMatchObject({ nome_arquivo: 'notas.txt', formato: 'txt' });
    const anexos = f.coletar();
    expect(anexos).toHaveLength(1);
    expect(anexos[0]!.buffer.toString('utf8')).toContain('acentuação');
  });

  it('CSV ganha BOM UTF-8 (planilhas abrem acentos corretamente)', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    await f.gerar({ nome_arquivo: 'dados', formato: 'csv', conteudo: 'col1,col2\n1,2' });
    const buffer = f.coletar()[0]!.buffer;
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(f.coletar()[0]!.nome_arquivo).toBe('dados.csv');
  });

  it('rejeita formato desconhecido, conteúdo vazio e conteúdo acima do teto', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    await expect(
      f.gerar({ nome_arquivo: 'x', formato: 'exe' as never, conteudo: 'a' }),
    ).rejects.toThrow(/formato inválido/);
    await expect(f.gerar({ nome_arquivo: 'x', formato: 'txt', conteudo: '   ' })).rejects.toThrow(
      /conteudo vazio/,
    );
    const enorme = 'a'.repeat(ferramentasConfig.artefatos.maxConteudoChars + 1);
    await expect(f.gerar({ nome_arquivo: 'x', formato: 'txt', conteudo: enorme })).rejects.toThrow(
      /limite/,
    );
  });

  it('impõe o teto de artefatos por execução; nome repetido SUBSTITUI (não conta)', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    const max = ferramentasConfig.artefatos.maxPorExecucao;
    for (let i = 0; i < max; i++) {
      await f.gerar({ nome_arquivo: `a${i}`, formato: 'txt', conteudo: 'x' });
    }
    await expect(
      f.gerar({ nome_arquivo: 'excedente', formato: 'txt', conteudo: 'x' }),
    ).rejects.toThrow(/limite de/);
    // Mesmo nome: substitui a versão anterior sem estourar o teto.
    await f.gerar({ nome_arquivo: 'a0', formato: 'txt', conteudo: 'nova versão' });
    const a0 = f.coletar().find((a) => a.nome_arquivo === 'a0.txt');
    expect(a0!.buffer.toString('utf8')).toBe('nova versão');
    expect(f.coletar()).toHaveLength(max);
  });

  it('valida o buffer gerado com a MESMA validação do upload (binário como txt falha)', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    await expect(
      f.gerar({ nome_arquivo: 'x', formato: 'txt', conteudo: 'abc\x00\x01\x02def' }),
    ).rejects.toThrow(/validação de anexos/);
  });

  it('gera PDF real (magic %PDF-) a partir de markdown com tabela e títulos', async () => {
    const f = criarFerramentaArtefatos(registrarNoop);
    const conteudo = [
      '# Relatório de chamados',
      '',
      'Resumo do período com **totais** e detalhes.',
      '',
      '| Métrica | Valor |',
      '| --- | --- |',
      '| Abertos | 12 |',
      '| Resolvidos | 9 |',
      '',
      '- item um',
      '- item dois',
      '  - subitem',
      '',
      '1. primeiro',
      '2. segundo',
    ].join('\n');
    const r = await f.gerar({
      nome_arquivo: 'relatorio',
      formato: 'pdf',
      conteudo,
      titulo: 'Relatório mensal — junho',
    });
    expect(r.nome_arquivo).toBe('relatorio.pdf');
    const buffer = f.coletar()[0]!.buffer;
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

describe('gerarPdfDeMarkdown (D-026)', () => {
  it('não quebra com markdown vazio/estranho e pagina conteúdo longo', async () => {
    const curto = await gerarPdfDeMarkdown(null, '');
    expect(curto.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const longo = await gerarPdfDeMarkdown(
      'Longo',
      Array.from(
        { length: 200 },
        (_, i) => `Parágrafo ${i} com texto suficiente para ocupar.`,
      ).join('\n\n'),
    );
    // Mais de uma página: /Type /Page aparece múltiplas vezes.
    const paginas = longo.toString('latin1').match(/\/Type \/Page[^s]/g) ?? [];
    expect(paginas.length).toBeGreaterThan(1);
  });

  it('normaliza caracteres fora do WinAnsi sem lançar (—, “aspas”, emoji)', async () => {
    const buffer = await gerarPdfDeMarkdown('Título', 'Texto — com “aspas” e emoji 🚀 e ção.');
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
