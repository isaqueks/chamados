import {
  detectarTipo,
  markdownParaDoc,
  MAX_ANEXOS_POR_MENSAGEM,
  MAX_IMAGENS_INLINE,
  PREFIXO_IMAGEM_ENVIADA,
  TAMANHO_MAX_ANEXO_BYTES,
  type ArquivoUpload,
  type DocRico,
  type MotivoArquivo,
  type NoRichText,
} from '@chamados/db';
import { VisibilidadeMensagem } from '@chamados/shared';
import type { CodigoErro } from './api-v1';
import { parsearEntradaCriar, valorEnum, type EntradaCriarApi } from './api-chamados';

/**
 * Upload de arquivos pela API `/api/v1` (D-046, specs/11 §4.3/§4.5): leitura do
 * `multipart/form-data` com teto de tamanho, extração e validação dos arquivos e
 * montagem do corpo com as imagens NA conversa.
 *
 * Módulo PURO (sem banco, sem `next/headers`, sem `server-only`) — testável com
 * `Request`/`FormData`/`File` nativos. Não há validação paralela: o tipo de cada
 * arquivo é decidido por `detectarTipo` (magic bytes + allowlist — specs/09 §5),
 * a MESMA função que o serviço de domínio roda de novo antes de gravar. Aqui ela
 * roda antes só para (a) separar imagem de documento e (b) devolver um erro
 * preciso (tipo × tamanho) em vez do genérico `anexo_invalido` do serviço.
 */

/**
 * Teto da requisição multipart INTEIRA. É o mesmo `bodySizeLimit` das server
 * actions da UI e o `proxyClientMaxBodySize` do proxy (next.config.ts) — acima
 * deste valor o proxy truncaria o corpo em silêncio. Um arquivo pode ter até
 * 25 MB (`TAMANHO_MAX_ANEXO_BYTES`); vários somados não passam de 32 MB.
 */
export const LIMITE_REQUISICAO_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Quantidade máxima de arquivos por requisição (= anexos por mensagem, specs/04 §6). */
export const MAX_ARQUIVOS_POR_REQUISICAO = MAX_ANEXOS_POR_MENSAGEM;

/** Nomes aceitos para as partes de arquivo (`arquivos` ou a grafia `arquivos[]`). */
export const CAMPOS_ARQUIVO = ['arquivos', 'arquivos[]'] as const;

/** Tipos aceitos, para as mensagens de erro (specs/04 §6). */
export const TIPOS_ACEITOS =
  'PNG, JPEG, WEBP, GIF, PDF, DOCX, XLSX, ZIP, TXT, LOG, CSV, MD (SVG e executáveis não)';

export interface FalhaUpload {
  ok: false;
  status: 400 | 413 | 415;
  codigo: CodigoErro;
  erro: string;
}

function falha(status: FalhaUpload['status'], codigo: CodigoErro, erro: string): FalhaUpload {
  return { ok: false, status, codigo, erro };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// ---------------------------------------------------------------------------
// Corpo da requisição
// ---------------------------------------------------------------------------

/** `Content-Type` é `multipart/form-data` (com ou sem `boundary`)? */
export function ehMultipart(contentType: string | null): boolean {
  return /^multipart\/form-data\s*(;|$)/i.test((contentType ?? '').trim());
}

/**
 * Recusa CEDO, pelo `Content-Length`, antes de ler um byte do corpo. Sem o
 * header (corpo `chunked`) devolve `null` e a leitura é limitada em
 * `lerFormularioMultipart`.
 */
export function checarTamanhoDeclarado(
  contentLength: string | null,
  limite = LIMITE_REQUISICAO_UPLOAD_BYTES,
): FalhaUpload | null {
  if (contentLength === null || contentLength.trim() === '') return null;
  const n = Number(contentLength);
  if (!Number.isInteger(n) || n < 0) {
    return falha(400, 'corpo_invalido', 'Cabeçalho Content-Length inválido.');
  }
  if (n > limite) {
    return falha(
      413,
      'requisicao_muito_grande',
      `A requisição (${mb(n)}) excede o limite de ${mb(limite)} somando todos os arquivos. ` +
        'Envie em mais de uma mensagem.',
    );
  }
  return null;
}

/** Lê um stream até `limite` bytes; passou disso, para e recusa (sem buffer infinito). */
async function lerStreamLimitado(
  corpo: ReadableStream<Uint8Array> | null,
  limite: number,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | FalhaUpload> {
  if (!corpo) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };
  const leitor = corpo.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel().catch(() => undefined);
      return falha(
        413,
        'requisicao_muito_grande',
        `A requisição excede o limite de ${mb(limite)} somando todos os arquivos. ` +
          'Envie em mais de uma mensagem.',
      );
    }
    partes.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let pos = 0;
  for (const p of partes) {
    bytes.set(p, pos);
    pos += p.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Lê o `multipart/form-data` de uma requisição com o teto de
 * `LIMITE_REQUISICAO_UPLOAD_BYTES`:
 *  - com `Content-Length`: recusa (413) antes de ler se passar do teto; senão o
 *    parser nativo lê exatamente esse tamanho (o HTTP não entrega mais que isso);
 *  - sem `Content-Length` (`chunked`): lê contando e corta no teto.
 * Corpo que não é multipart válido → `400 corpo_invalido`.
 */
export async function lerFormularioMultipart(
  req: Request,
  limite = LIMITE_REQUISICAO_UPLOAD_BYTES,
): Promise<{ ok: true; form: FormData } | FalhaUpload> {
  const declarado = req.headers.get('content-length');
  const recusa = checarTamanhoDeclarado(declarado, limite);
  if (recusa) return recusa;

  const invalido = falha(
    400,
    'corpo_invalido',
    'Corpo multipart/form-data malformado (confira o boundary e as partes).',
  );
  try {
    if (declarado !== null && declarado.trim() !== '')
      return { ok: true, form: await req.formData() };
    const lido = await lerStreamLimitado(req.body, limite);
    if (!lido.ok) return lido;
    const reconstruido = new Response(lido.bytes, {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    });
    return { ok: true, form: await reconstruido.formData() };
  } catch {
    return invalido;
  }
}

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

/** Arquivo recebido, já validado por `detectarTipo`. */
export interface ArquivoRecebido {
  nome_arquivo: string;
  buffer: Buffer;
  content_type: string;
  /** Imagem elegível a aparecer na conversa (PNG/JPEG/WEBP/GIF). */
  imagem: boolean;
}

/**
 * Nome de exibição seguro: só o basename (separadores `/` e `\` descartados —
 * nome nunca vira caminho), sem caracteres de controle, até 255 caracteres. Vazio
 * ou `.`/`..` vira `arquivo-<n>`. O nome NÃO decide o tipo (só refina ZIP→OOXML e
 * habilita texto, como na UI).
 */
export function nomeArquivoSeguro(nome: string, indice: number): string {
  const base = (nome.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex -- remove controles ASCII/C1 do nome enviado
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 255);
  return base && base !== '.' && base !== '..' ? base : `arquivo-${indice + 1}`;
}

function rotulo(nome: string, i: number): string {
  return `arquivo ${i + 1} ("${nome}")`;
}

function falhaDeteccao(motivo: MotivoArquivo, nome: string, i: number): FalhaUpload {
  switch (motivo) {
    case 'vazio':
      return falha(400, 'parametro_invalido', `O ${rotulo(nome, i)} está vazio.`);
    case 'muito_grande':
      return falha(
        413,
        'arquivo_muito_grande',
        `O ${rotulo(nome, i)} excede ${mb(TAMANHO_MAX_ANEXO_BYTES)} por arquivo.`,
      );
    case 'tipo_nao_suportado':
    case 'conteudo_incompativel':
      return falha(
        415,
        'tipo_arquivo_nao_permitido',
        `O ${rotulo(nome, i)} não é de um tipo permitido (validado pelo conteúdo, não pela ` +
          `extensão). Aceitos: ${TIPOS_ACEITOS}.`,
      );
  }
}

/**
 * Extrai e valida os arquivos do formulário, NA ORDEM enviada. Tudo é checado
 * antes de qualquer efeito: quantidade, tamanho declarado (antes de copiar os
 * bytes), depois o tipo real por `detectarTipo`. Um arquivo ruim recusa a
 * requisição inteira — nada é publicado pela metade.
 */
export async function extrairArquivos(
  form: FormData,
): Promise<{ ok: true; arquivos: ArquivoRecebido[] } | FalhaUpload> {
  const partes = CAMPOS_ARQUIVO.flatMap((c) => form.getAll(c));
  if (partes.length > MAX_ARQUIVOS_POR_REQUISICAO) {
    return falha(
      400,
      'arquivos_demais',
      `No máximo ${MAX_ARQUIVOS_POR_REQUISICAO} arquivos por requisição (vieram ${partes.length}).`,
    );
  }
  const arquivos: File[] = [];
  for (const [i, parte] of partes.entries()) {
    if (typeof parte === 'string') {
      return falha(
        400,
        'parametro_invalido',
        `"arquivos" deve conter arquivos (partes com filename); a parte ${i + 1} é texto.`,
      );
    }
    if (parte.size > TAMANHO_MAX_ANEXO_BYTES) {
      return falhaDeteccao('muito_grande', nomeArquivoSeguro(parte.name, i), i);
    }
    arquivos.push(parte);
  }

  const recebidos: ArquivoRecebido[] = [];
  for (const [i, arq] of arquivos.entries()) {
    const nome = nomeArquivoSeguro(arq.name, i);
    const buffer = Buffer.from(await arq.arrayBuffer());
    const det = detectarTipo(buffer, nome);
    if (!det.ok) return falhaDeteccao(det.motivo, nome, i);
    recebidos.push({
      nome_arquivo: nome,
      buffer,
      content_type: det.tipo.contentType,
      imagem: det.tipo.imagem,
    });
  }
  return { ok: true, arquivos: recebidos };
}

// ---------------------------------------------------------------------------
// Corpo com imagens na conversa
// ---------------------------------------------------------------------------

/** Marcador que posiciona uma imagem enviada no markdown: `![legenda](anexo:nome.png)`. */
const RE_MARCADOR = /^anexo:(.+)$/i;

export interface CorpoMontado {
  /** Doc pronto para o domínio (`criarMensagem`/`criarChamado`). */
  doc: DocRico;
  /** Imagens que entram NA conversa (`imagens_inline` — índice = `anexo-enviado:<i>`). */
  imagens: ArquivoUpload[];
  /** Demais arquivos (anexos à parte). */
  anexos: ArquivoUpload[];
}

/**
 * Monta o doc do corpo a partir do markdown + arquivos enviados (D-046):
 *
 *  - **Imagem** (PNG/JPEG/WEBP/GIF) aparece NA conversa, como uma imagem colada
 *    no editor. Onde: no **marcador** `![legenda](anexo:<nome do arquivo>)` se o
 *    markdown tiver um; senão, **ao fim do corpo**, na ordem de envio, com o nome
 *    do arquivo como texto alternativo.
 *  - **Demais tipos** viram anexos comuns ("arquivos anexados").
 *
 * Marcador para um nome que não foi enviado, que não é imagem, ambíguo (dois
 * arquivos com o mesmo nome) ou repetido → `400`: uma imagem que não aparece onde
 * o autor pediu é pior que um erro corrigível. `![x](https://…)` e qualquer outra
 * imagem do markdown seguem a regra de sempre (viram o texto alternativo).
 */
export function montarCorpoComArquivos(
  markdown: string,
  arquivos: ArquivoRecebido[],
): { ok: true; corpo: CorpoMontado } | FalhaUpload {
  const imagens = arquivos.filter((a) => a.imagem);
  const anexos = arquivos.filter((a) => !a.imagem);
  if (imagens.length > MAX_IMAGENS_INLINE) {
    return falha(
      400,
      'arquivos_demais',
      `No máximo ${MAX_IMAGENS_INLINE} imagens por mensagem (vieram ${imagens.length}).`,
    );
  }

  const usadas = new Set<number>();
  let erroMarcador: string | null = null;
  const srcImagem = (href: string): string | null => {
    const m = RE_MARCADOR.exec(href.trim());
    if (!m || erroMarcador) return null;
    let nome = m[1]!;
    try {
      nome = decodeURIComponent(nome);
    } catch {
      /* usa o texto cru */
    }
    const indices = imagens.flatMap((img, i) => (img.nome_arquivo === nome ? [i] : []));
    if (indices.length === 0) {
      const outro = anexos.some((a) => a.nome_arquivo === nome);
      erroMarcador = outro
        ? `O marcador "anexo:${nome}" aponta para um arquivo que não é imagem — só imagens ` +
          'aparecem no texto; os demais arquivos vão como anexo (sem marcador).'
        : `O marcador "anexo:${nome}" não corresponde a nenhum arquivo enviado (use o nome ` +
          'exato do arquivo).';
      return null;
    }
    if (indices.length > 1) {
      erroMarcador = `O marcador "anexo:${nome}" é ambíguo: há mais de um arquivo com esse nome.`;
      return null;
    }
    const i = indices[0]!;
    if (usadas.has(i)) {
      erroMarcador = `A imagem "${nome}" foi posicionada mais de uma vez — use um marcador por imagem.`;
      return null;
    }
    usadas.add(i);
    return `${PREFIXO_IMAGEM_ENVIADA}${i}`;
  };

  const texto = markdown.trim();
  const base: DocRico =
    texto.length > 0 ? markdownParaDoc(markdown, { srcImagem }) : { type: 'doc', content: [] };
  if (erroMarcador) return falha(400, 'parametro_invalido', erroMarcador);

  const finais: NoRichText[] = [];
  imagens.forEach((img, i) => {
    if (!usadas.has(i)) {
      finais.push({
        type: 'image',
        attrs: { src: `${PREFIXO_IMAGEM_ENVIADA}${i}`, alt: img.nome_arquivo },
      });
    }
  });
  const doc: DocRico = { type: 'doc', content: [...(base.content ?? []), ...finais] };

  const upload = (a: ArquivoRecebido): ArquivoUpload => ({
    nome_arquivo: a.nome_arquivo,
    buffer: a.buffer,
  });
  return { ok: true, corpo: { doc, imagens: imagens.map(upload), anexos: anexos.map(upload) } };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

/** Campo de texto do formulário (`null` se ausente ou se veio como arquivo). */
function campoTexto(form: FormData, nome: string): string | null {
  const v = form.get(nome);
  return typeof v === 'string' ? v : null;
}

/** `POST …/mensagens` em multipart, já validado e montado. */
export interface MensagemMultipart {
  visibilidade: VisibilidadeMensagem;
  corpo: CorpoMontado;
}

/**
 * Formulário de `POST /api/v1/chamados/{ref}/mensagens` (D-046): `visibilidade`
 * (`publica` | `interna`), `corpo` (markdown) e `arquivos` (0..N). O corpo pode
 * ficar vazio SE houver ao menos uma imagem — a mesma regra do editor da UI, em
 * que uma imagem colada sozinha é mensagem válida e um arquivo anexado sem texto
 * não é (o domínio recusa com `corpo_vazio`).
 */
export async function parsearMensagemMultipart(
  form: FormData,
): Promise<{ ok: true; mensagem: MensagemMultipart } | FalhaUpload> {
  const visBruta = campoTexto(form, 'visibilidade')?.trim();
  if (!visBruta) {
    return falha(400, 'parametro_invalido', 'Informe "visibilidade": "publica" ou "interna".');
  }
  const visibilidade = valorEnum(VisibilidadeMensagem, visBruta);
  if (!visibilidade) {
    return falha(400, 'parametro_invalido', 'Visibilidade deve ser "publica" ou "interna".');
  }

  const ext = await extrairArquivos(form);
  if (!ext.ok) return ext;

  const markdown = campoTexto(form, 'corpo') ?? '';
  if (markdown.trim().length === 0 && !ext.arquivos.some((a) => a.imagem)) {
    return falha(
      400,
      'corpo_invalido',
      'O campo "corpo" não pode ser vazio — ele só é dispensável quando a mensagem traz ao ' +
        'menos uma imagem (que aparece na conversa).',
    );
  }

  const montado = montarCorpoComArquivos(markdown, ext.arquivos);
  if (!montado.ok) return montado;
  return { ok: true, mensagem: { visibilidade, corpo: montado.corpo } };
}

/** Campos de texto de `POST /api/v1/chamados` (os mesmos do JSON — specs/11 §4.5). */
const CAMPOS_CRIAR = [
  'titulo',
  'descricao',
  'natureza',
  'prioridade',
  'sistema_alvo_id',
  'categoria_id',
  'solicitante_email',
  'solicitante_id',
  'estimativa_custo',
] as const;

/**
 * Formulário de `POST /api/v1/chamados` (D-046): os campos de texto do JSON +
 * `arquivos`, que na abertura só podem ser **imagens** — entram na descrição como
 * as coladas no portal (marcador ou ao fim). Outros tipos → `415`: a descrição
 * não tem "arquivos anexados" na UI; publique-os numa mensagem logo depois. A
 * `descricao` continua obrigatória (como no JSON).
 */
export async function parsearCriarMultipart(
  form: FormData,
): Promise<
  { ok: true; entrada: EntradaCriarApi; imagens: ArquivoUpload[]; doc: DocRico } | FalhaUpload
> {
  const campos: Record<string, unknown> = {};
  for (const c of CAMPOS_CRIAR) {
    const v = campoTexto(form, c);
    if (v !== null) campos[c] = v;
  }
  const parse = parsearEntradaCriar(campos);
  if (!parse.ok) return falha(400, parse.codigo, parse.erro);

  const ext = await extrairArquivos(form);
  if (!ext.ok) return ext;
  const naoImagem = ext.arquivos.findIndex((a) => !a.imagem);
  if (naoImagem >= 0) {
    return falha(
      415,
      'tipo_arquivo_nao_permitido',
      `Na abertura só imagens (PNG, JPEG, WEBP, GIF) — elas entram na descrição. O ` +
        `${rotulo(ext.arquivos[naoImagem]!.nome_arquivo, naoImagem)} não é imagem: abra o ` +
        'chamado e envie-o em POST /api/v1/chamados/{ref}/mensagens.',
    );
  }

  const montado = montarCorpoComArquivos(parse.entrada.descricao, ext.arquivos);
  if (!montado.ok) return montado;
  return {
    ok: true,
    entrada: parse.entrada,
    imagens: montado.corpo.imagens,
    doc: montado.corpo.doc,
  };
}
