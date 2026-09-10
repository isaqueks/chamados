import { describe, it, expect } from 'vitest';
import {
  montarQueryListar,
  caminhoChamado,
  montarCorpoCriar,
  classificarAnexo,
  nomeArquivoSeguro,
  montarResultadoAnexo,
  diretorioPadraoAnexos,
  MAX_IMAGEM_INLINE_BYTES,
  MAX_TEXTO_INLINE_CHARS,
} from './ferramentas';
import type { ArquivoBaixado } from './cliente';

/** Tradução de argumentos das ferramentas → contrato HTTP (specs/11 §4.1/§7.2). */
describe('ferramentas do MCP', () => {
  it('serializa a lista de status separada por vírgula', () => {
    const q = montarQueryListar({ status: ['novo', 'em_triagem'] });
    expect(q.status).toBe('novo,em_triagem');
  });

  it('omite filtros ausentes (nada de parâmetro vazio na URL)', () => {
    const q = montarQueryListar({});
    expect(Object.values(q).every((v) => v === undefined)).toBe(true);
  });

  it('omite `status` quando a lista vem vazia', () => {
    expect(montarQueryListar({ status: [] }).status).toBeUndefined();
  });

  it('converte limite numérico para string', () => {
    expect(montarQueryListar({ limite: 50 }).limite).toBe('50');
  });

  it('escapa a referência do chamado no caminho', () => {
    expect(caminhoChamado('12')).toBe('/api/v1/chamados/12');
    // `#` viraria fragmento de URL se não fosse escapado — o número sumiria.
    expect(caminhoChamado('#12')).toBe('/api/v1/chamados/%2312');
    expect(caminhoChamado(' 12 ', '/mensagens')).toBe('/api/v1/chamados/12/mensagens');
  });
});

/** Corpo de `chamado_criar` → `POST /api/v1/chamados` (specs/11 §4.5). */
describe('montarCorpoCriar', () => {
  it('envia só os campos informados (opcional vazio não viaja)', () => {
    const corpo = montarCorpoCriar({
      titulo: '  Boleto não gera  ',
      descricao: 'Tela em branco.',
      natureza: '',
      sistema_alvo_id: undefined,
    });
    expect(corpo).toEqual({ titulo: 'Boleto não gera', descricao: 'Tela em branco.' });
  });

  it('inclui natureza, prioridade, sistema-alvo e solicitante quando presentes', () => {
    const corpo = montarCorpoCriar({
      titulo: 'Relatório novo',
      descricao: 'Precisamos de um relatório mensal.',
      natureza: 'alteracao',
      prioridade: 'alta',
      sistema_alvo_id: '9b7e2f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      solicitante_email: ' ana@cliente.com ',
    });
    expect(corpo.natureza).toBe('alteracao');
    expect(corpo.prioridade).toBe('alta');
    expect(corpo.sistema_alvo_id).toBe('9b7e2f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b');
    expect(corpo.solicitante_email).toBe('ana@cliente.com');
  });
});

/** Anexos (specs/11 §4.7/§7.2): classificação, nome seguro e montagem da resposta. */
describe('anexo_obter', () => {
  const ID = '9b7e2f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const semDisco = async () => {
    throw new Error('não deveria gravar');
  };
  const gravaFake = async (_a: ArquivoBaixado, id: string, dir: string) =>
    `${dir}/${nomeArquivoSeguro(_a.nomeArquivo, id)}`;

  it('classifica por content-type', () => {
    expect(classificarAnexo('image/png')).toBe('imagem');
    expect(classificarAnexo('text/csv; charset=utf-8')).toBe('texto');
    expect(classificarAnexo('application/json')).toBe('texto');
    expect(classificarAnexo('application/pdf')).toBe('binario');
  });

  it('nome seguro: só basename, sem traversal, prefixado pelo id', () => {
    expect(nomeArquivoSeguro('../../etc/passwd', ID)).toBe('9b7e2f0a-passwd');
    expect(nomeArquivoSeguro('C:\\tmp\\print.png', ID)).toBe('9b7e2f0a-print.png');
    expect(nomeArquivoSeguro(null, ID)).toBe('9b7e2f0a-anexo');
    expect(nomeArquivoSeguro('..', ID)).toBe('9b7e2f0a-anexo');
  });

  it('imagem pequena volta INLINE (type image) sem tocar o disco', async () => {
    const r = await montarResultadoAnexo(
      { corpo: Buffer.from('png-bytes'), contentType: 'image/png', nomeArquivo: 'tela.png' },
      ID,
      undefined,
      semDisco,
    );
    expect(r.content[0]).toEqual({
      type: 'image',
      data: Buffer.from('png-bytes').toString('base64'),
      mimeType: 'image/png',
    });
    expect(r.content[1]).toMatchObject({ type: 'text' });
  });

  it('texto volta inline e é truncado acima do limite', async () => {
    const grande = 'x'.repeat(MAX_TEXTO_INLINE_CHARS + 5000);
    const r = await montarResultadoAnexo(
      { corpo: Buffer.from(grande), contentType: 'text/plain', nomeArquivo: 'app.log' },
      ID,
      undefined,
      semDisco,
    );
    const t = (r.content[0] as { text: string }).text;
    expect(t).toContain('truncado');
    expect(t.endsWith('x'.repeat(10))).toBe(true);
    expect(t.length).toBeLessThan(grande.length);
  });

  it('binário vai para disco (salvar_em ou temporário) e devolve o caminho', async () => {
    const r = await montarResultadoAnexo(
      { corpo: Buffer.from('%PDF'), contentType: 'application/pdf', nomeArquivo: 'nota.pdf' },
      ID,
      '/tmp/x',
      gravaFake,
    );
    expect((r.content[0] as { text: string }).text).toContain('/tmp/x/9b7e2f0a-nota.pdf');
    const r2 = await montarResultadoAnexo(
      { corpo: Buffer.from('%PDF'), contentType: 'application/pdf', nomeArquivo: 'nota.pdf' },
      ID,
      undefined,
      gravaFake,
    );
    expect((r2.content[0] as { text: string }).text).toContain(diretorioPadraoAnexos());
  });

  it('imagem acima do limite inline vai para disco', async () => {
    const r = await montarResultadoAnexo(
      {
        corpo: Buffer.alloc(MAX_IMAGEM_INLINE_BYTES + 1),
        contentType: 'image/jpeg',
        nomeArquivo: 'foto.jpg',
      },
      ID,
      undefined,
      gravaFake,
    );
    expect(r.content[0]?.type).toBe('text');
    expect((r.content[0] as { text: string }).text).toContain('limite inline');
  });
});
