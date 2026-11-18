import { describe, it, expect } from 'vitest';
import {
  validarDocRico,
  renderizarHtml,
  docParaMarkdown,
  PREFIXO_IMAGEM_ENVIADA,
  TAMANHO_MAX_ANEXO_BYTES,
  type DocRico,
} from '@chamados/db';
import {
  checarTamanhoDeclarado,
  ehMultipart,
  extrairArquivos,
  lerFormularioMultipart,
  montarCorpoComArquivos,
  nomeArquivoSeguro,
  parsearCriarMultipart,
  parsearMensagemMultipart,
  LIMITE_REQUISICAO_UPLOAD_BYTES,
  MAX_ARQUIVOS_POR_REQUISICAO,
  type ArquivoRecebido,
} from './api-upload';

/**
 * Upload pela API multipart (D-046, specs/11 §4.3/§4.5): teto da requisição,
 * validação dos arquivos pelo MESMO `detectarTipo` do domínio e a regra das
 * imagens na conversa (marcador `anexo:` ou ao fim do corpo). A régua final é o
 * pipeline real: o doc montado precisa passar em `validarDocRico` com as imagens.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'latin1');

function arquivo(buf: Buffer, nome: string): File {
  return new File([new Uint8Array(buf)], nome);
}

function form(campos: Record<string, string>, arquivos: File[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const a of arquivos) fd.append('arquivos', a);
  return fd;
}

function recebido(buf: Buffer, nome: string, imagem: boolean): ArquivoRecebido {
  return {
    nome_arquivo: nome,
    buffer: buf,
    content_type: imagem ? 'image/png' : 'application/pdf',
    imagem,
  };
}

/** Imagens (nós `image`) do doc, em ordem de documento. */
function imagensDo(doc: DocRico): Array<{ src: string; alt?: string }> {
  const out: Array<{ src: string; alt?: string }> = [];
  const visitar = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === 'image') {
      out.push({ src: String(n.attrs?.src), alt: n.attrs?.alt as string | undefined });
    }
    for (const f of (n.content ?? []) as (typeof n)[]) visitar(f);
  };
  for (const n of doc.content ?? []) visitar(n);
  return out;
}

describe('ehMultipart / checarTamanhoDeclarado', () => {
  it('reconhece multipart com ou sem boundary, e só ele', () => {
    expect(ehMultipart('multipart/form-data; boundary=x')).toBe(true);
    expect(ehMultipart('Multipart/Form-Data')).toBe(true);
    expect(ehMultipart('application/json')).toBe(false);
    expect(ehMultipart('multipart/form-datax')).toBe(false);
    expect(ehMultipart(null)).toBe(false);
  });

  it('recusa cedo (413) o que declara passar do teto, sem ler o corpo', () => {
    const r = checarTamanhoDeclarado(String(LIMITE_REQUISICAO_UPLOAD_BYTES + 1));
    expect(r).toMatchObject({ status: 413, codigo: 'requisicao_muito_grande' });
    expect(checarTamanhoDeclarado(String(LIMITE_REQUISICAO_UPLOAD_BYTES))).toBeNull();
    expect(checarTamanhoDeclarado(null)).toBeNull();
    expect(checarTamanhoDeclarado('abc')).toMatchObject({ status: 400, codigo: 'corpo_invalido' });
  });
});

describe('lerFormularioMultipart', () => {
  it('lê o formulário de uma requisição real', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      body: form({ visibilidade: 'publica' }, [arquivo(PNG, 'a.png')]),
    });
    const r = await lerFormularioMultipart(req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.form.get('visibilidade')).toBe('publica');
  });

  it('com Content-Length acima do teto recusa 413', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': '999' },
      body: '--b--',
    });
    const r = await lerFormularioMultipart(req, 100);
    expect(r).toMatchObject({ ok: false, status: 413, codigo: 'requisicao_muito_grande' });
  });

  it('sem Content-Length (chunked) corta no teto ao ler o stream', async () => {
    const pedacos = [new Uint8Array(60), new Uint8Array(60)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pedacos) c.enqueue(p);
        c.close();
      },
    });
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const r = await lerFormularioMultipart(req, 100);
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it('corpo multipart malformado → 400 corpo_invalido', async () => {
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': '7' },
      body: 'lixo!!!',
    });
    expect(await lerFormularioMultipart(req)).toMatchObject({
      status: 400,
      codigo: 'corpo_invalido',
    });
  });
});

describe('nomeArquivoSeguro', () => {
  it('fica só com o basename, sem controles', () => {
    expect(nomeArquivoSeguro('../../etc/passwd', 0)).toBe('passwd');
    expect(nomeArquivoSeguro('C:\\Users\\a\\print.png', 0)).toBe('print.png');
    expect(nomeArquivoSeguro('a\u0000b\n.png', 0)).toBe('ab.png');
  });
  it('nome vazio ou ponto vira arquivo-<n>', () => {
    expect(nomeArquivoSeguro('', 2)).toBe('arquivo-3');
    expect(nomeArquivoSeguro('..', 0)).toBe('arquivo-1');
  });
});

describe('extrairArquivos', () => {
  it('valida pelo conteúdo e separa imagem de documento, na ordem', async () => {
    const r = await extrairArquivos(form({}, [arquivo(PDF, 'r.pdf'), arquivo(PNG, 'p.png')]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arquivos.map((a) => [a.nome_arquivo, a.content_type, a.imagem])).toEqual([
      ['r.pdf', 'application/pdf', false],
      ['p.png', 'image/png', true],
    ]);
  });

  it('aceita a grafia `arquivos[]`', async () => {
    const fd = new FormData();
    fd.append('arquivos[]', arquivo(PNG, 'p.png'));
    const r = await extrairArquivos(fd);
    expect(r.ok && r.arquivos.length).toBe(1);
  });

  it('SVG e executável → 415 tipo_arquivo_nao_permitido (mesmo com extensão de imagem)', async () => {
    for (const [buf, nome] of [
      [SVG, 'logo.svg'],
      [SVG, 'logo.png'],
      [EXE, 'setup.exe'],
      [EXE, 'leia.txt'],
    ] as const) {
      const r = await extrairArquivos(form({}, [arquivo(PNG, 'ok.png'), arquivo(buf, nome)]));
      expect(r).toMatchObject({ ok: false, status: 415, codigo: 'tipo_arquivo_nao_permitido' });
      if (!r.ok) expect(r.erro).toContain('arquivo 2');
    }
  });

  it('arquivo acima de 25 MB → 413 arquivo_muito_grande (antes de copiar os bytes)', async () => {
    const grande = new File([new Uint8Array(TAMANHO_MAX_ANEXO_BYTES + 1)], 'grande.png');
    const r = await extrairArquivos(form({}, [grande]));
    expect(r).toMatchObject({ status: 413, codigo: 'arquivo_muito_grande' });
  });

  it('mais arquivos que o limite → 400 arquivos_demais', async () => {
    const muitos = Array.from({ length: MAX_ARQUIVOS_POR_REQUISICAO + 1 }, (_, i) =>
      arquivo(PNG, `${i}.png`),
    );
    expect(await extrairArquivos(form({}, muitos))).toMatchObject({
      status: 400,
      codigo: 'arquivos_demais',
    });
  });

  it('parte de texto no campo de arquivos e arquivo vazio → 400', async () => {
    const fd = new FormData();
    fd.append('arquivos', 'não sou arquivo');
    expect(await extrairArquivos(fd)).toMatchObject({ status: 400, codigo: 'parametro_invalido' });
    expect(await extrairArquivos(form({}, [arquivo(Buffer.alloc(0), 'v.png')]))).toMatchObject({
      status: 400,
    });
  });
});

describe('montarCorpoComArquivos — imagens na conversa', () => {
  it('sem marcador: imagens ao fim do corpo (alt = nome), documentos como anexo', () => {
    const r = montarCorpoComArquivos('Segue o print.', [
      recebido(PDF, 'r.pdf', false),
      recebido(PNG, 'tela.png', true),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.corpo.anexos.map((a) => a.nome_arquivo)).toEqual(['r.pdf']);
    expect(r.corpo.imagens.map((a) => a.nome_arquivo)).toEqual(['tela.png']);
    const ultimo = r.corpo.doc.content!.at(-1)!;
    expect(ultimo).toEqual({
      type: 'image',
      attrs: { src: `${PREFIXO_IMAGEM_ENVIADA}0`, alt: 'tela.png' },
    });
  });

  it('marcador `![legenda](anexo:nome)` posiciona a imagem no texto (com nome codificado)', () => {
    const r = montarCorpoComArquivos(
      'Antes:\n\n![tela antes](anexo:antes.png)\n\nDepois:\n\n![tela depois](anexo:meu%20depois.png)',
      [recebido(PNG, 'antes.png', true), recebido(PNG, 'meu depois.png', true)],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(imagensDo(r.corpo.doc)).toEqual([
      { src: `${PREFIXO_IMAGEM_ENVIADA}0`, alt: 'tela antes' },
      { src: `${PREFIXO_IMAGEM_ENVIADA}1`, alt: 'tela depois' },
    ]);
  });

  it('mistura: a marcada fica no lugar, a não marcada vai ao fim', () => {
    const r = montarCorpoComArquivos('Veja ![a](anexo:a.png) aqui.', [
      recebido(PNG, 'a.png', true),
      recebido(PNG, 'b.png', true),
    ]);
    if (!r.ok) throw new Error(r.erro);
    expect(imagensDo(r.corpo.doc).map((i) => i.src)).toEqual([
      `${PREFIXO_IMAGEM_ENVIADA}0`,
      `${PREFIXO_IMAGEM_ENVIADA}1`,
    ]);
    expect(r.corpo.doc.content!.at(-1)!.attrs?.alt).toBe('b.png');
  });

  it('marcador inválido → 400 explicando (inexistente, não-imagem, repetido, ambíguo)', () => {
    const casos: Array<[string, ArquivoRecebido[], string]> = [
      ['![x](anexo:nao.png)', [recebido(PNG, 'a.png', true)], 'não corresponde'],
      ['![x](anexo:r.pdf)', [recebido(PDF, 'r.pdf', false)], 'não é imagem'],
      ['![x](anexo:a.png) ![y](anexo:a.png)', [recebido(PNG, 'a.png', true)], 'mais de uma vez'],
      [
        '![x](anexo:a.png)',
        [recebido(PNG, 'a.png', true), recebido(PNG, 'a.png', true)],
        'ambíguo',
      ],
    ];
    for (const [md, arqs, trecho] of casos) {
      const r = montarCorpoComArquivos(md, arqs);
      expect(r).toMatchObject({ ok: false, status: 400, codigo: 'parametro_invalido' });
      if (!r.ok) expect(r.erro).toContain(trecho);
    }
  });

  it('imagem de URL externa e marcador sem arquivo não injetam nada além do texto', () => {
    const r = montarCorpoComArquivos('![logo](https://evil.example/x.png)', []);
    if (!r.ok) throw new Error(r.erro);
    expect(imagensDo(r.corpo.doc)).toEqual([]);
  });

  it('o doc montado passa no pipeline REAL e vira <img> referenciando anexo', () => {
    const r = montarCorpoComArquivos('Erro **na tela**:\n\n![print](anexo:p.png)', [
      recebido(PNG, 'p.png', true),
    ]);
    if (!r.ok) throw new Error(r.erro);
    const val = validarDocRico(r.corpo.doc, { imagensEnviadas: r.corpo.imagens });
    expect(val.ok).toBe(true);
    if (!val.ok) return;
    expect(val.validado.imagens).toHaveLength(1);
    expect(val.validado.imagens[0]!.nome_arquivo).toBe('p.png');
    // Fase 2 simulada: o src vira a ref interna; o HTML e o markdown de saída mostram a imagem.
    val.validado.imagens[0]!.no.attrs = {
      ...val.validado.imagens[0]!.no.attrs,
      src: '/api/anexos/abc',
    };
    expect(renderizarHtml(val.validado.doc)).toContain('<img src="/api/anexos/abc" alt="print"');
    expect(docParaMarkdown(val.validado.doc)).toContain('![print](/api/anexos/abc)');
  });

  it('sem a lista de imagens enviadas, `anexo-enviado:` é DESCARTADO pelo pipeline', () => {
    const doc: DocRico = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'oi' }] },
        { type: 'image', attrs: { src: `${PREFIXO_IMAGEM_ENVIADA}0` } },
      ],
    };
    const val = validarDocRico(doc);
    expect(val.ok && val.validado.imagens.length).toBe(0);
  });

  it('o pipeline recusa imagem enviada que não é imagem, índice repetido ou não usado', () => {
    const img = (i: number) => ({ type: 'image', attrs: { src: `${PREFIXO_IMAGEM_ENVIADA}${i}` } });
    const pdf = [{ nome_arquivo: 'r.pdf', buffer: PDF }];
    const png = [{ nome_arquivo: 'p.png', buffer: PNG }];
    expect(validarDocRico({ type: 'doc', content: [img(0)] }, { imagensEnviadas: pdf })).toEqual({
      ok: false,
      motivo: 'imagem_invalida',
    });
    expect(
      validarDocRico({ type: 'doc', content: [img(0), img(0)] }, { imagensEnviadas: png }),
    ).toEqual({ ok: false, motivo: 'imagem_invalida' });
    expect(
      validarDocRico(
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
        { imagensEnviadas: png },
      ),
    ).toEqual({ ok: false, motivo: 'imagem_invalida' });
  });
});

describe('parsearMensagemMultipart', () => {
  it('monta visibilidade + doc + anexos', async () => {
    const r = await parsearMensagemMultipart(
      form({ visibilidade: 'interna', corpo: 'Relatório' }, [
        arquivo(PNG, 'p.png'),
        arquivo(PDF, 'r.pdf'),
      ]),
    );
    if (!r.ok) throw new Error(r.erro);
    expect(r.mensagem.visibilidade).toBe('interna');
    expect(r.mensagem.corpo.imagens).toHaveLength(1);
    expect(r.mensagem.corpo.anexos).toHaveLength(1);
  });

  it('corpo vazio só com imagem (regra do editor); com só PDF → 400', async () => {
    const soImagem = await parsearMensagemMultipart(
      form({ visibilidade: 'publica' }, [arquivo(PNG, 'p.png')]),
    );
    expect(soImagem.ok).toBe(true);
    if (soImagem.ok) {
      const val = validarDocRico(soImagem.mensagem.corpo.doc, {
        imagensEnviadas: soImagem.mensagem.corpo.imagens,
      });
      expect(val.ok).toBe(true);
    }
    const soPdf = await parsearMensagemMultipart(
      form({ visibilidade: 'publica', corpo: '  ' }, [arquivo(PDF, 'r.pdf')]),
    );
    expect(soPdf).toMatchObject({ ok: false, status: 400, codigo: 'corpo_invalido' });
  });

  it('visibilidade ausente/inválida → 400; tipo proibido → 415 antes de montar', async () => {
    expect(await parsearMensagemMultipart(form({ corpo: 'x' }))).toMatchObject({ status: 400 });
    expect(
      await parsearMensagemMultipart(form({ visibilidade: 'secreta', corpo: 'x' })),
    ).toMatchObject({ status: 400 });
    expect(
      await parsearMensagemMultipart(
        form({ visibilidade: 'publica', corpo: 'x' }, [arquivo(SVG, 'a.svg')]),
      ),
    ).toMatchObject({ status: 415 });
  });
});

describe('parsearCriarMultipart', () => {
  it('campos de texto como no JSON + imagens na descrição', async () => {
    const r = await parsearCriarMultipart(
      form({ titulo: 'Tela quebrada', descricao: 'Veja:', prioridade: 'alta' }, [
        arquivo(PNG, 'p.png'),
      ]),
    );
    if (!r.ok) throw new Error(r.erro);
    expect(r.entrada.titulo).toBe('Tela quebrada');
    expect(r.entrada.prioridade).toBe('alta');
    expect(r.imagens).toHaveLength(1);
    expect(r.doc.content!.at(-1)!.type).toBe('image');
  });

  it('na abertura, arquivo que não é imagem → 415; campo inválido → 400 do parser JSON', async () => {
    const pdf = await parsearCriarMultipart(
      form({ titulo: 'Tela quebrada', descricao: 'x' }, [arquivo(PDF, 'r.pdf')]),
    );
    expect(pdf).toMatchObject({ status: 415, codigo: 'tipo_arquivo_nao_permitido' });
    const semDescricao = await parsearCriarMultipart(form({ titulo: 'Tela quebrada' }));
    expect(semDescricao).toMatchObject({ status: 400, codigo: 'corpo_invalido' });
    const natureza = await parsearCriarMultipart(
      form({ titulo: 'Tela quebrada', descricao: 'x', natureza: 'bug' }),
    );
    expect(natureza).toMatchObject({ status: 400, codigo: 'parametro_invalido' });
  });
});
