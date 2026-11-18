import { deflateRawSync } from 'node:zlib';

/**
 * Gerador de planilhas `.xlsx` (OOXML/SpreadsheetML) com ZERO dependências
 * (D-034): usado pela EXTRAÇÃO POR CONSULTA, em que o worker executa o SELECT e
 * materializa o resultado — o modelo nunca redigita as linhas.
 *
 * Um `.xlsx` é só um ZIP de XMLs. Como não podemos (nem queremos) trazer uma
 * lib de planilha para o worker, este módulo escreve o ZIP na mão (local file
 * headers + central directory + EOCD, método 8/deflate via `node:zlib`, CRC-32
 * por tabela) e emite o pacote MÍNIMO que o Excel/LibreOffice aceitam:
 * `[Content_Types].xml`, `_rels/.rels`, `docProps/{app,core}.xml`,
 * `xl/workbook.xml` (+ rels), `xl/styles.xml` e `xl/worksheets/sheet1.xml`.
 *
 * A planilha sai pronta para uso: cabeçalho em negrito, painel congelado abaixo
 * dele, autofiltro na faixa e larguras de coluna proporcionais ao conteúdo.
 * Strings vão como `inlineStr` (sem tabela de strings compartilhadas) —
 * simplicidade acima de bytes, já que o teto de linhas é do chamador.
 *
 * Mora em `@chamados/db/planilha` (D-045) — subpath SERVER-ONLY (usa
 * `node:zlib`), compartilhado pelo worker (extração por consulta, D-034) e pelo
 * web (exportação da fila/portal). Nunca entra no índice de `@chamados/shared`,
 * que também é empacotado para o browser (front da Forja).
 *
 * **Injeção de fórmula (CSV/formula injection — specs/09 §6):** o gerador NUNCA
 * emite `<f>`; todo texto vai como `inlineStr`, que o Excel/LibreOffice exibem
 * literalmente. Como defesa extra contra a reavaliação ao editar a célula
 * (F2+Enter) ou ao salvar como CSV, textos que começam com `=` `+` `-` `@` (ou
 * TAB/CR) recebem um estilo com `quotePrefix="1"` — o mesmo efeito do apóstrofo
 * digitado à mão, sem alterar o conteúdo visível.
 */

/** Formato numérico opcional por coluna (D-045). */
export type FormatoColunaXlsx = 'moeda';

export interface PlanilhaXlsx {
  /** Nome da aba (sanitizado; default `Dados`). */
  nomeAba?: string;
  colunas: string[];
  /** Matriz de valores na MESMA ordem de `colunas`. */
  linhas: unknown[][];
  /**
   * Como escrever valores `Date` (D-045). `texto` (default, D-034): string
   * `AAAA-MM-DD HH:MM:SS` em UTC. `data`: data/hora NATIVA do Excel (número de
   * série com formato `dd/mm/aaaa hh:mm`), convertida para o `fusoHorario` —
   * ordena, filtra e calcula como data na planilha.
   */
  datas?: 'texto' | 'data';
  /** Fuso IANA usado quando `datas: 'data'` (default `UTC`). */
  fusoHorario?: string;
  /** Formato por índice de coluna (ex.: `moeda` → `#,##0.00`). Só afeta números. */
  formatos?: ReadonlyArray<FormatoColunaXlsx | undefined>;
}

/** MIME oficial do `.xlsx`. */
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// --------------------------------------------------------------------- CRC-32

let tabelaCrc: Uint32Array | null = null;

function obterTabelaCrc(): Uint32Array {
  if (tabelaCrc) return tabelaCrc;
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  tabelaCrc = tabela;
  return tabela;
}

/** CRC-32 (IEEE 802.3), como o ZIP exige. Exportado para teste. */
export function crc32(buffer: Buffer): number {
  const tabela = obterTabelaCrc();
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = (tabela[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------- Escritor ZIP

interface EntradaZip {
  nome: string;
  dados: Buffer;
}

/**
 * Data/hora DOS fixa (2024-01-01 00:00:00): o pacote não precisa de mtime real
 * e uma data constante deixa a saída DETERMINÍSTICA (bom para teste/diff).
 */
const DOS_HORA = 0;
const DOS_DATA = ((2024 - 1980) << 9) | (1 << 5) | 1;

/** Monta o ZIP (deflate) das entradas na ordem dada. */
function escreverZip(entradas: EntradaZip[]): Buffer {
  const locais: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entrada of entradas) {
    const nome = Buffer.from(entrada.nome, 'utf8');
    const bruto = entrada.dados;
    const comprimido = deflateRawSync(bruto, { level: 9 });
    const crc = crc32(bruto);

    const local = Buffer.alloc(30 + nome.length);
    local.writeUInt32LE(0x04034b50, 0); // assinatura do local file header
    local.writeUInt16LE(20, 4); // versão necessária (2.0 = deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // método: deflate
    local.writeUInt16LE(DOS_HORA, 10);
    local.writeUInt16LE(DOS_DATA, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(bruto.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28); // sem campo extra
    nome.copy(local, 30);
    locais.push(local, comprimido);

    const cabecalho = Buffer.alloc(46 + nome.length);
    cabecalho.writeUInt32LE(0x02014b50, 0); // assinatura do central directory
    cabecalho.writeUInt16LE(20, 4); // versão de criação
    cabecalho.writeUInt16LE(20, 6); // versão necessária
    cabecalho.writeUInt16LE(0, 8);
    cabecalho.writeUInt16LE(8, 10);
    cabecalho.writeUInt16LE(DOS_HORA, 12);
    cabecalho.writeUInt16LE(DOS_DATA, 14);
    cabecalho.writeUInt32LE(crc, 16);
    cabecalho.writeUInt32LE(comprimido.length, 20);
    cabecalho.writeUInt32LE(bruto.length, 24);
    cabecalho.writeUInt16LE(nome.length, 28);
    cabecalho.writeUInt16LE(0, 30); // extra
    cabecalho.writeUInt16LE(0, 32); // comentário
    cabecalho.writeUInt16LE(0, 34); // disco
    cabecalho.writeUInt16LE(0, 36); // atributos internos
    cabecalho.writeUInt32LE(0, 38); // atributos externos
    cabecalho.writeUInt32LE(offset, 42); // offset do local header
    nome.copy(cabecalho, 46);
    central.push(cabecalho);

    offset += local.length + comprimido.length;
  }

  const diretorio = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); // end of central directory
  fim.writeUInt16LE(0, 4); // disco atual
  fim.writeUInt16LE(0, 6); // disco do início do diretório
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(offset, 16);
  fim.writeUInt16LE(0, 20); // sem comentário

  return Buffer.concat([...locais, diretorio, fim]);
}

// ---------------------------------------------------------------- Utilitários

// eslint-disable-next-line no-control-regex
const CONTROLE_INVALIDO = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Escapa para XML e REMOVE os caracteres de controle inválidos em XML 1.0. */
export function escaparXml(texto: string): string {
  return texto
    .replace(CONTROLE_INVALIDO, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Referência de coluna a partir do índice 0-based: 0 → A, 25 → Z, 26 → AA. */
export function letraColuna(indice: number): string {
  let n = Math.max(0, Math.floor(indice));
  let letra = '';
  for (;;) {
    letra = String.fromCharCode(65 + (n % 26)) + letra;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return letra;
  }
}

/** Data em `AAAA-MM-DD HH:MM:SS` (UTC) — mesmo formato usado no CSV. */
export function formatarDataPlanilha(data: Date): string {
  const iso = data.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** Nome de aba válido: sem `[]:*?/\`, no máximo 31 chars, default `Dados`. */
export function sanitizarNomeAba(nome: string | undefined): string {
  const limpo = (nome ?? '')
    .replace(/[[\]:*?/\\]/g, '')
    .replace(CONTROLE_INVALIDO, '')
    .trim()
    .slice(0, 31)
    .trim();
  return limpo.length > 0 ? limpo : 'Dados';
}

/**
 * Texto que uma planilha poderia interpretar como fórmula/comando DDE se a
 * célula fosse reeditada ou o arquivo convertido para CSV (OWASP "CSV
 * injection"): começa com `=`, `+`, `-`, `@`, TAB ou CR.
 */
export function pareceFormula(texto: string): boolean {
  return /^[=+\-@\t\r]/.test(texto);
}

const MS_POR_DIA = 86_400_000;
/** 1970-01-01 no sistema de datas 1900 do Excel (já com o bug do 29/02/1900). */
const EPOCA_EXCEL_UNIX = 25_569;

const cacheFormatadores = new Map<string, Intl.DateTimeFormat>();

function formatadorFuso(fuso: string): Intl.DateTimeFormat {
  let f = cacheFormatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cacheFormatadores.set(fuso, f);
  }
  return f;
}

/**
 * Número de série do Excel (dias desde 1899-12-30, fração = hora) para o
 * instante `data` visto no relógio de parede do `fuso` (IANA). Exportado para teste.
 */
export function serialExcel(data: Date, fuso = 'UTC'): number {
  const partes = Object.fromEntries(
    formatadorFuso(fuso)
      .formatToParts(data)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const localMs = Date.UTC(
    Number(partes.year),
    Number(partes.month) - 1,
    Number(partes.day),
    Number(partes.hour),
    Number(partes.minute),
    Number(partes.second),
  );
  // Precisão de segundo: o formato exibido é minuto; evita dízimas enormes no XML.
  return Math.round((localMs / MS_POR_DIA + EPOCA_EXCEL_UNIX) * 86_400) / 86_400;
}

/** Célula: `n` (número), `b` (booleano) ou texto inline. `null` = célula omitida. */
type Celula =
  | { tipo: 'n' | 'b'; valor: string; estilo?: number }
  | { tipo: 'texto'; valor: string; estilo?: number }
  | null;

/** Índices de `cellXfs` em `STYLES_XML`. */
const ESTILO_NEGRITO = 1;
const ESTILO_TEXTO_LITERAL = 2;
const ESTILO_DATA_HORA = 3;
const ESTILO_MOEDA = 4;

interface OpcoesCelula {
  datas: 'texto' | 'data';
  fusoHorario: string;
}

function converterCelula(valor: unknown, opcoes: OpcoesCelula): Celula {
  const celula = converterCelulaBruta(valor, opcoes);
  if (celula && celula.tipo === 'texto' && pareceFormula(celula.valor)) {
    return { ...celula, estilo: ESTILO_TEXTO_LITERAL };
  }
  return celula;
}

function converterCelulaBruta(valor: unknown, opcoes: OpcoesCelula): Celula {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') {
    return Number.isFinite(valor)
      ? { tipo: 'n', valor: String(valor) }
      : { tipo: 'texto', valor: String(valor) };
  }
  if (typeof valor === 'boolean') return { tipo: 'b', valor: valor ? '1' : '0' };
  if (typeof valor === 'bigint') {
    const seguro =
      valor <= BigInt(Number.MAX_SAFE_INTEGER) && valor >= BigInt(Number.MIN_SAFE_INTEGER);
    return seguro
      ? { tipo: 'n', valor: valor.toString() }
      : { tipo: 'texto', valor: valor.toString() };
  }
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return { tipo: 'texto', valor: '' };
    if (opcoes.datas === 'data') {
      return {
        tipo: 'n',
        valor: String(serialExcel(valor, opcoes.fusoHorario)),
        estilo: ESTILO_DATA_HORA,
      };
    }
    return { tipo: 'texto', valor: formatarDataPlanilha(valor) };
  }
  if (typeof valor === 'object') {
    let texto: string;
    try {
      texto = JSON.stringify(valor) ?? '';
    } catch {
      texto = String(valor);
    }
    return { tipo: 'texto', valor: texto };
  }
  return { tipo: 'texto', valor: String(valor) };
}

// -------------------------------------------------------------- Partes OOXML

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES = `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const RELS_RAIZ = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const APP_XML = `${DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Chamados</Application></Properties>`;

const WORKBOOK_RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/**
 * Estilos MÍNIMOS válidos: 1 formato numérico próprio (`dd/mm/yyyy hh:mm`, id
 * 164), 2 fontes (normal/negrito), os 2 fills obrigatórios (`none` e
 * `gray125`), 1 border, 1 `cellStyleXfs` e 5 `cellXfs` — 0 normal, 1 negrito
 * (cabeçalho), 2 texto literal (`quotePrefix`, anti-fórmula), 3 data/hora,
 * 4 moeda (`#,##0.00`, formato embutido 4).
 */
const STYLES_XML = `${DECL}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function coreXml(titulo: string): string {
  return `${DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escaparXml(titulo)}</dc:title><dc:creator>Chamados</dc:creator><cp:lastModifiedBy>Chamados</cp:lastModifiedBy></cp:coreProperties>`;
}

function workbookXml(nomeAba: string): string {
  return `${DECL}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escaparXml(nomeAba)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** Larguras: proporcionais ao maior conteúdo da coluna, entre 8 e 60 chars. */
const LARGURA_MIN = 8;
const LARGURA_MAX = 60;

/** Largura que comporta `dd/mm/aaaa hh:mm` (o número de série é curto demais). */
const LARGURA_DATA = 17;

function sheetXml(
  colunas: string[],
  linhas: unknown[][],
  opcoes: OpcoesCelula,
  formatos: ReadonlyArray<FormatoColunaXlsx | undefined>,
): string {
  const totalColunas = Math.max(colunas.length, 1);
  const larguras = new Array<number>(colunas.length).fill(LARGURA_MIN);
  const partes: string[] = [];

  // Linha 1: cabeçalho em negrito (estilo 1).
  const cabecalho: string[] = [];
  for (let c = 0; c < colunas.length; c++) {
    const texto = colunas[c] ?? '';
    larguras[c] = Math.max(larguras[c] ?? LARGURA_MIN, texto.length + 2);
    cabecalho.push(
      `<c r="${letraColuna(c)}1" s="${ESTILO_NEGRITO}" t="inlineStr"><is><t xml:space="preserve">${escaparXml(texto)}</t></is></c>`,
    );
  }
  partes.push(`<row r="1">${cabecalho.join('')}</row>`);

  for (let i = 0; i < linhas.length; i++) {
    const origem = linhas[i] ?? [];
    const numeroLinha = i + 2;
    const celulas: string[] = [];
    for (let c = 0; c < colunas.length; c++) {
      const celula = converterCelula(origem[c], opcoes);
      if (celula === null) continue; // null/undefined: célula OMITIDA
      const ref = `${letraColuna(c)}${numeroLinha}`;
      let estilo = celula.estilo;
      if (estilo === undefined && celula.tipo === 'n' && formatos[c] === 'moeda') {
        estilo = ESTILO_MOEDA;
      }
      const largura =
        estilo === ESTILO_DATA_HORA
          ? LARGURA_DATA
          : estilo === ESTILO_MOEDA
            ? celula.valor.length + 4 // separadores de milhar + casas decimais
            : celula.valor.length + 2;
      larguras[c] = Math.max(larguras[c] ?? LARGURA_MIN, largura);
      const s = estilo === undefined ? '' : ` s="${estilo}"`;
      celulas.push(
        celula.tipo === 'texto'
          ? `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escaparXml(celula.valor)}</t></is></c>`
          : `<c r="${ref}"${s} t="${celula.tipo}"><v>${celula.valor}</v></c>`,
      );
    }
    partes.push(`<row r="${numeroLinha}">${celulas.join('')}</row>`);
  }

  const ultimaColuna = letraColuna(totalColunas - 1);
  const ultimaLinha = linhas.length + 1;
  const faixa = `A1:${ultimaColuna}${ultimaLinha}`;
  const cols =
    colunas.length > 0
      ? `<cols>${larguras
          .map(
            (l, c) =>
              `<col min="${c + 1}" max="${c + 1}" width="${Math.min(LARGURA_MAX, Math.max(LARGURA_MIN, Math.round(l)))}" customWidth="1"/>`,
          )
          .join('')}</cols>`
      : '';

  return `${DECL}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${faixa}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${partes.join('')}</sheetData><autoFilter ref="${faixa}"/></worksheet>`;
}

// ---------------------------------------------------------------------- API

/**
 * Gera o `.xlsx` completo (uma aba) a partir das colunas + matriz de valores.
 * Puro e síncrono: nenhuma I/O, nenhuma dependência externa.
 */
export function gerarXlsx(planilha: PlanilhaXlsx): Buffer {
  const nomeAba = sanitizarNomeAba(planilha.nomeAba);
  const colunas = planilha.colunas ?? [];
  const linhas = planilha.linhas ?? [];
  const opcoes: OpcoesCelula = {
    datas: planilha.datas ?? 'texto',
    fusoHorario: planilha.fusoHorario ?? 'UTC',
  };
  const sheet = sheetXml(colunas, linhas, opcoes, planilha.formatos ?? []);

  return escreverZip([
    { nome: '[Content_Types].xml', dados: Buffer.from(CONTENT_TYPES, 'utf8') },
    { nome: '_rels/.rels', dados: Buffer.from(RELS_RAIZ, 'utf8') },
    { nome: 'docProps/app.xml', dados: Buffer.from(APP_XML, 'utf8') },
    { nome: 'docProps/core.xml', dados: Buffer.from(coreXml(nomeAba), 'utf8') },
    { nome: 'xl/workbook.xml', dados: Buffer.from(workbookXml(nomeAba), 'utf8') },
    { nome: 'xl/_rels/workbook.xml.rels', dados: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { nome: 'xl/styles.xml', dados: Buffer.from(STYLES_XML, 'utf8') },
    { nome: 'xl/worksheets/sheet1.xml', dados: Buffer.from(sheet, 'utf8') },
  ]);
}
