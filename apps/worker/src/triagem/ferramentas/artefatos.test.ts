import { describe, it, expect } from 'vitest';
import { criarFerramentaArtefatos, gerarCsv, sanitizarNomeArtefato } from './artefatos';
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

describe('gerarCsv (D-034)', () => {
  it('segue a RFC 4180: aspas quando há separador/aspas/quebra, aspas dobradas, CRLF', () => {
    const csv = gerarCsv(
      ['nome', 'obs', 'valor'],
      [
        ['Comércio; Cia', 'diz "olá"', 10],
        ['quebra', 'linha 1\nlinha 2', null],
      ],
      ';',
    );
    const linhas = csv.split('\r\n');
    expect(linhas[0]).toBe('nome;obs;valor');
    expect(linhas[1]).toBe('"Comércio; Cia";"diz ""olá""";10');
    expect(csv).toContain('"linha 1\nlinha 2"');
    // null/undefined viram campo vazio.
    expect(csv.endsWith(';')).toBe(true);
  });

  it('formata Date como AAAA-MM-DD HH:MM:SS e objetos como JSON', () => {
    const csv = gerarCsv(
      ['quando', 'meta'],
      [[new Date(Date.UTC(2024, 5, 1, 13, 45, 30)), { a: 1 }]],
      ',',
    );
    expect(csv).toContain('2024-06-01 13:45:30');
    expect(csv).toContain('"{""a"":1}"');
  });
});

describe('artefato_consulta (D-034)', () => {
  const linhasFake = (n: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, nome: `Cliente ${i + 1}` }));

  it('gera CSV com o separador configurado, BOM e extensão forçada', async () => {
    const f = criarFerramentaArtefatos(registrarNoop, {
      extrair: async () => [
        { id: 1, nome: 'Comércio; & Cia' },
        { id: 2, nome: 'diz "olá"' },
      ],
    });
    const r = await f.consultar({ nome_arquivo: 'carteira', formato: 'csv', consulta: 'select 1' });
    expect(r).toMatchObject({ nome_arquivo: 'carteira.csv', formato: 'csv', linhas: 2 });
    expect(r.colunas).toEqual(['id', 'nome']);
    expect(r.truncado).toBe(false);
    const buffer = f.coletar()[0]!.buffer;
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const texto = buffer.toString('utf8');
    expect(texto).toContain('id;nome');
    expect(texto).toContain('"Comércio; & Cia"');
    expect(texto).toContain('"diz ""olá"""');
  });

  it('gera XLSX (assinatura PK) a partir do resultado da consulta', async () => {
    const f = criarFerramentaArtefatos(registrarNoop, { extrair: async () => linhasFake(3) });
    const r = await f.consultar({
      nome_arquivo: 'clientes',
      formato: 'xlsx',
      consulta: 'select * from clientes',
      titulo: 'Carteira X',
    });
    expect(r.nome_arquivo).toBe('clientes.xlsx');
    const buffer = f.coletar()[0]!.buffer;
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('devolve amostra de no máximo 5 linhas e marca `truncado` no teto', async () => {
    const teto = ferramentasConfig.artefatos.maxLinhasExtracao;
    const f = criarFerramentaArtefatos(registrarNoop, {
      extrair: async (_sql, max) => linhasFake(max),
    });
    const r = await f.consultar({ nome_arquivo: 'tudo', formato: 'csv', consulta: 'select 1' });
    expect(r.linhas).toBe(teto);
    expect(r.truncado).toBe(true);
    expect(r.amostra).toHaveLength(5);
    expect(r.amostra[0]).toEqual({ id: 1, nome: 'Cliente 1' });
  });

  it('recusa formato inválido, falta de conexão de BD e consulta sem linhas', async () => {
    const f = criarFerramentaArtefatos(registrarNoop, { extrair: async () => linhasFake(1) });
    await expect(
      f.consultar({ nome_arquivo: 'x', formato: 'pdf' as never, consulta: 'select 1' }),
    ).rejects.toThrow(/formato inválido/);

    const semBd = criarFerramentaArtefatos(registrarNoop);
    await expect(
      semBd.consultar({ nome_arquivo: 'x', formato: 'csv', consulta: 'select 1' }),
    ).rejects.toThrow(/conexão de BD do sistema-alvo não configurada/);

    const vazio = criarFerramentaArtefatos(registrarNoop, { extrair: async () => [] });
    await expect(
      vazio.consultar({ nome_arquivo: 'x', formato: 'csv', consulta: 'select 1' }),
    ).rejects.toThrow(/não retornou linhas/);
  });

  it('propaga o erro do executor (validação SELECT-only) ao modelo', async () => {
    const f = criarFerramentaArtefatos(registrarNoop, {
      extrair: async () => {
        throw new Error('apenas consultas SELECT/WITH são permitidas (acesso read-only)');
      },
    });
    await expect(
      f.consultar({ nome_arquivo: 'x', formato: 'csv', consulta: 'delete from clientes' }),
    ).rejects.toThrow(/SELECT\/WITH/);
  });

  it('nome repetido SUBSTITUI (conta 1) e o teto por execução vale para a extração', async () => {
    const f = criarFerramentaArtefatos(registrarNoop, { extrair: async () => linhasFake(2) });
    await f.consultar({ nome_arquivo: 'lista', formato: 'csv', consulta: 'select 1' });
    await f.consultar({ nome_arquivo: 'lista', formato: 'csv', consulta: 'select 2' });
    expect(f.coletar()).toHaveLength(1);

    const max = ferramentasConfig.artefatos.maxPorExecucao;
    for (let i = 1; i < max; i++) {
      await f.consultar({ nome_arquivo: `lista${i}`, formato: 'csv', consulta: 'select 1' });
    }
    expect(f.coletar()).toHaveLength(max);
    await expect(
      f.consultar({ nome_arquivo: 'excedente', formato: 'csv', consulta: 'select 1' }),
    ).rejects.toThrow(/limite de/);
  });

  it('registra a ação `artefato_consulta` com o SQL (trilha única, sem duplicar)', async () => {
    const acoes: { ferramenta: string; args: unknown }[] = [];
    const f = criarFerramentaArtefatos((ferramenta, args) => acoes.push({ ferramenta, args }), {
      extrair: async () => linhasFake(1),
    });
    await f.consultar({ nome_arquivo: 'x', formato: 'csv', consulta: 'select 1 as id' });
    expect(acoes).toHaveLength(1);
    expect(acoes[0]!.ferramenta).toBe('artefato_consulta');
    expect(acoes[0]!.args).toMatchObject({ formato: 'csv', sql: 'select 1 as id' });
  });
});
