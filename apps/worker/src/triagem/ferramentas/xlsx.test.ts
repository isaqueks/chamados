import { inflateRawSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { gerarXlsx, crc32, letraColuna, sanitizarNomeAba } from './xlsx';

/**
 * Gerador de XLSX sem dependências (D-034). Como não há lib de planilha no
 * worker, o teste traz um LEITOR ZIP mínimo (percorre os local file headers e
 * descomprime com `inflateRawSync`) e valida o XML que sai de fato do pacote —
 * prova de que o arquivo é um ZIP bem formado E uma planilha correta.
 */

/** Leitor ZIP mínimo: local file headers em sequência (sem data descriptor). */
function lerZip(buffer: Buffer): Map<string, string> {
  const arquivos = new Map<string, string>();
  let off = 0;
  while (off + 30 <= buffer.length && buffer.readUInt32LE(off) === 0x04034b50) {
    const metodo = buffer.readUInt16LE(off + 8);
    const comprimido = buffer.readUInt32LE(off + 18);
    const tamanhoNome = buffer.readUInt16LE(off + 26);
    const tamanhoExtra = buffer.readUInt16LE(off + 28);
    const nome = buffer.toString('utf8', off + 30, off + 30 + tamanhoNome);
    const inicio = off + 30 + tamanhoNome + tamanhoExtra;
    const dados = buffer.subarray(inicio, inicio + comprimido);
    arquivos.set(nome, (metodo === 8 ? inflateRawSync(dados) : dados).toString('utf8'));
    off = inicio + comprimido;
  }
  return arquivos;
}

describe('crc32 (ZIP)', () => {
  it('bate com o vetor de teste canônico "123456789" → 0xCBF43926', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('letraColuna / sanitizarNomeAba', () => {
  it('converte índice em referência de coluna (A..Z, AA..)', () => {
    expect(letraColuna(0)).toBe('A');
    expect(letraColuna(25)).toBe('Z');
    expect(letraColuna(26)).toBe('AA');
    expect(letraColuna(27)).toBe('AB');
    expect(letraColuna(51)).toBe('AZ');
    expect(letraColuna(52)).toBe('BA');
  });
  it('sanitiza o nome da aba (caracteres proibidos, 31 chars, default)', () => {
    expect(sanitizarNomeAba('Clientes[2024]/carteira:X')).toBe('Clientes2024carteiraX');
    expect(sanitizarNomeAba('')).toBe('Dados');
    expect(sanitizarNomeAba(undefined)).toBe('Dados');
    expect(sanitizarNomeAba('a'.repeat(50))).toHaveLength(31);
  });
});

describe('gerarXlsx (D-034)', () => {
  const planilha = {
    nomeAba: 'Carteira X',
    colunas: ['nome', 'valor', 'ativo', 'obs'],
    linhas: [
      ['Comércio & Cia', 1234.5, true, null],
      ['Fulano <de> Tal', 7, false, new Date(Date.UTC(2024, 5, 1, 13, 45, 30))],
    ],
  };

  it('produz um ZIP (assinatura PK\\x03\\x04) com todas as partes do pacote', () => {
    const buffer = gerarXlsx(planilha);
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const partes = lerZip(buffer);
    expect([...partes.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
      ]),
    );
  });

  it('a planilha tem cabeçalho em negrito, tipos corretos, escape XML e freeze pane', () => {
    const sheet = lerZip(gerarXlsx(planilha)).get('xl/worksheets/sheet1.xml')!;
    // Cabeçalho: linha 1 com o estilo negrito (s="1").
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">nome</t>');
    // Número → t="n" com <v>; booleano → t="b" com 1/0.
    expect(sheet).toContain('<c r="B2" t="n"><v>1234.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="C3" t="b"><v>0</v></c>');
    // String com `&` e `<>` escapada.
    expect(sheet).toContain('Comércio &amp; Cia');
    expect(sheet).toContain('Fulano &lt;de&gt; Tal');
    // Data como texto legível.
    expect(sheet).toContain('2024-06-01 13:45:30');
    // null: célula OMITIDA (não existe D2, mas existe D3 com a data).
    expect(sheet).not.toContain('r="D2"');
    expect(sheet).toContain('r="D3"');
    // Painel congelado abaixo do cabeçalho + autofiltro na faixa.
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    // Larguras declaradas dentro dos limites (8..60).
    const larguras = [...sheet.matchAll(/<col [^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(larguras).toHaveLength(4);
    for (const l of larguras) {
      expect(l).toBeGreaterThanOrEqual(8);
      expect(l).toBeLessThanOrEqual(60);
    }
  });

  it('remove caracteres de controle inválidos em XML 1.0 (mantendo \\t \\n \\r)', () => {
    const sheet = lerZip(gerarXlsx({ colunas: ['c'], linhas: [['a\x00\x01b\tc\nd']] })).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('ab\tc\nd');
    expect(sheet).not.toContain('\x00');
  });

  it('[Content_Types].xml declara a worksheet e os styles; a aba é sanitizada', () => {
    const partes = lerZip(gerarXlsx({ nomeAba: 'Rel*ório?/2024', colunas: ['a'], linhas: [] }));
    const tipos = partes.get('[Content_Types].xml')!;
    expect(tipos).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(tipos).toContain('PartName="/xl/styles.xml"');
    expect(partes.get('xl/workbook.xml')!).toContain('name="Relório2024"');
  });

  it('aguenta muitas linhas/colunas sem estourar (500 x 30)', () => {
    const colunas = Array.from({ length: 30 }, (_, i) => `col_${i}`);
    const linhas = Array.from({ length: 500 }, (_, r) => colunas.map((_c, i) => r * 30 + i));
    const buffer = gerarXlsx({ colunas, linhas });
    const sheet = lerZip(buffer).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<autoFilter ref="A1:AD501"/>');
    expect(sheet).toContain('r="AD501"');
  });
});
