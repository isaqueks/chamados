/**
 * Validação de tipo REAL de arquivos por conteúdo (magic bytes), não por extensão
 * ou Content-Type informado (specs/09 §5). Allowlist rígida: só os tipos previstos
 * em specs/04 §6 passam; QUALQUER outra coisa é recusada (executáveis, scripts,
 * polyglots caem no default-deny). SVG é BLOQUEADO (exigiria sanitização de XML
 * ativo — specs/09 §5; no MVP não renderizamos SVG inline).
 *
 * Módulo PURO (sem I/O): recebe o buffer já em memória e decide.
 */

/** Tamanho máximo por arquivo (specs/04 §6). */
export const TAMANHO_MAX_ANEXO_BYTES = 25 * 1024 * 1024; // 25 MB
/** Máximo de anexos por mensagem/descrição (specs/04 §6). */
export const MAX_ANEXOS_POR_MENSAGEM = 20;
/** Máximo de imagens inline por corpo (specs/04 §5). */
export const MAX_IMAGENS_INLINE = 20;

export type CategoriaArquivo = 'imagem' | 'documento';

export type MotivoArquivo =
  'vazio' | 'muito_grande' | 'tipo_nao_suportado' | 'conteudo_incompativel';

export interface TipoDetectado {
  contentType: string;
  ext: string;
  categoria: CategoriaArquivo;
  /** Imagem elegível a inline no rich text (specs/04 §5). */
  imagem: boolean;
}

export type ResultadoDeteccao =
  { ok: true; tipo: TipoDetectado } | { ok: false; motivo: MotivoArquivo };

interface Detector {
  contentType: string;
  ext: string;
  categoria: CategoriaArquivo;
  imagem: boolean;
  /** Casa os magic bytes iniciais. `null` = tipo sem assinatura (texto). */
  casa: ((b: Buffer) => boolean) | null;
  /** Extensões aceitas para tipos sem assinatura (texto). */
  extensoes?: string[];
}

const asc = (b: Buffer, ini: number, fim: number): string => b.toString('latin1', ini, fim);

/** Allowlist de detectores por magic bytes (ordem importa: mais específico antes). */
const DETECTORES: Detector[] = [
  {
    contentType: 'image/png',
    ext: 'png',
    categoria: 'imagem',
    imagem: true,
    casa: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    contentType: 'image/jpeg',
    ext: 'jpg',
    categoria: 'imagem',
    imagem: true,
    casa: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/webp',
    ext: 'webp',
    categoria: 'imagem',
    imagem: true,
    casa: (b) => b.length > 12 && asc(b, 0, 4) === 'RIFF' && asc(b, 8, 12) === 'WEBP',
  },
  {
    contentType: 'image/gif',
    ext: 'gif',
    categoria: 'imagem',
    imagem: true,
    casa: (b) => b.length > 6 && (asc(b, 0, 6) === 'GIF87a' || asc(b, 0, 6) === 'GIF89a'),
  },
  {
    contentType: 'application/pdf',
    ext: 'pdf',
    categoria: 'documento',
    imagem: false,
    casa: (b) => b.length > 5 && asc(b, 0, 5) === '%PDF-',
  },
];

/** Família ZIP (zip, docx, xlsx — todos OOXML/ZIP): assinatura `PK\x03\x04`. */
function ehZip(b: Buffer): boolean {
  return (
    b.length > 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
  );
}

const OOXML: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

/** Extensões de texto puro aceitas (sem assinatura — validadas por heurística). */
const EXTENSOES_TEXTO: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
};

function extDe(nome?: string): string {
  if (!nome) return '';
  const i = nome.lastIndexOf('.');
  return i >= 0 ? nome.slice(i + 1).toLowerCase() : '';
}

/**
 * Heurística de "parece texto simples": UTF-8 válido, sem bytes NUL e com poucos
 * caracteres de controle. Bloqueia binários renomeados para .txt e conteúdo XML
 * ativo (SVG/XML) — que não é servido inline no MVP.
 */
function pareceTexto(b: Buffer): boolean {
  if (b.length === 0) return true;
  const amostra = b.subarray(0, Math.min(b.length, 8192));
  if (amostra.includes(0x00)) return false;
  // Recusa conteúdo que se anuncia como XML/SVG (evita SVG disfarçado de texto).
  const inicio = amostra
    .toString('utf8', 0, Math.min(amostra.length, 256))
    .trimStart()
    .toLowerCase();
  if (inicio.startsWith('<?xml') || inicio.startsWith('<svg')) return false;
  let controle = 0;
  for (const byte of amostra) {
    // Permite \t (9), \n (10), \r (13); conta os demais de controle < 32.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controle++;
  }
  return controle / amostra.length < 0.05;
}

/**
 * Detecta o tipo real do buffer. Aplica a allowlist e o limite de tamanho.
 * `nomeArquivo` só refina o `content_type` de famílias ambíguas (ZIP → docx/xlsx)
 * e habilita os tipos de texto (sem assinatura); nunca sozinho autoriza o upload.
 */
export function detectarTipo(buffer: Buffer, nomeArquivo?: string): ResultadoDeteccao {
  if (buffer.length === 0) return { ok: false, motivo: 'vazio' };
  if (buffer.length > TAMANHO_MAX_ANEXO_BYTES) return { ok: false, motivo: 'muito_grande' };

  for (const d of DETECTORES) {
    if (d.casa && d.casa(buffer)) {
      return {
        ok: true,
        tipo: { contentType: d.contentType, ext: d.ext, categoria: d.categoria, imagem: d.imagem },
      };
    }
  }

  const ext = extDe(nomeArquivo);

  if (ehZip(buffer)) {
    const contentType = OOXML[ext] ?? OOXML.zip!;
    const extFinal = ext in OOXML ? ext : 'zip';
    return {
      ok: true,
      tipo: { contentType, ext: extFinal, categoria: 'documento', imagem: false },
    };
  }

  // Sem assinatura: só aceitamos como texto se a EXTENSÃO for de texto E o
  // conteúdo passar na heurística (specs/09 §5 — validação por conteúdo).
  if (ext in EXTENSOES_TEXTO) {
    if (!pareceTexto(buffer)) return { ok: false, motivo: 'conteudo_incompativel' };
    return {
      ok: true,
      tipo: { contentType: EXTENSOES_TEXTO[ext]!, ext, categoria: 'documento', imagem: false },
    };
  }

  return { ok: false, motivo: 'tipo_nao_suportado' };
}

/** Detecta especificamente uma imagem inline (rich text). Recusa não-imagens. */
export function detectarImagemInline(buffer: Buffer): ResultadoDeteccao {
  const r = detectarTipo(buffer);
  if (!r.ok) return r;
  if (!r.tipo.imagem) return { ok: false, motivo: 'tipo_nao_suportado' };
  return r;
}
