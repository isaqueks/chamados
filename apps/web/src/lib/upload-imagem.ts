import 'server-only';

/**
 * Validação de imagem de branding no servidor (specs/09 §5): tipo REAL por magic
 * bytes (não confia na extensão nem no Content-Type), allowlist de formatos
 * rasterizados seguros e limite de tamanho. SVG é recusado aqui (exigiria
 * sanitização — specs/09 §5); logos usam PNG/JPEG/WEBP.
 */

export const TAMANHO_MAX_LOGO_BYTES = 1024 * 1024; // 1 MB

interface FormatoImagem {
  contentType: string;
  ext: string;
  /** Testa os magic bytes iniciais do arquivo. */
  casa: (b: Buffer) => boolean;
}

const FORMATOS: FormatoImagem[] = [
  {
    contentType: 'image/png',
    ext: 'png',
    casa: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    contentType: 'image/jpeg',
    ext: 'jpg',
    casa: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/webp',
    ext: 'webp',
    casa: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

export type ResultadoImagem =
  { ok: true; buffer: Buffer; contentType: string; ext: string } | { ok: false; erro: string };

/**
 * Valida um `File` de upload (imagem de logo). Retorna o buffer + tipo real ou
 * uma mensagem de erro amigável.
 */
export async function validarImagemLogo(arquivo: File): Promise<ResultadoImagem> {
  if (!arquivo || arquivo.size === 0) {
    return { ok: false, erro: 'Selecione um arquivo de imagem.' };
  }
  if (arquivo.size > TAMANHO_MAX_LOGO_BYTES) {
    return {
      ok: false,
      erro: `Imagem muito grande (máx. ${Math.round(TAMANHO_MAX_LOGO_BYTES / 1024)} KB).`,
    };
  }
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const formato = FORMATOS.find((f) => f.casa(buffer));
  if (!formato) {
    return {
      ok: false,
      erro: 'Formato não suportado. Use PNG, JPEG ou WEBP.',
    };
  }
  return {
    ok: true,
    buffer,
    contentType: formato.contentType,
    ext: formato.ext,
  };
}
