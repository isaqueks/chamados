import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  montarQueryListar,
  caminhoChamado,
  montarCorpoCriar,
  montarCorpoStatus,
  classificarAnexo,
  nomeArquivoSeguro,
  montarResultadoAnexo,
  diretorioPadraoAnexos,
  MAX_IMAGEM_INLINE_BYTES,
  MAX_TEXTO_INLINE_CHARS,
  executarPublicarMensagem,
  executarCriarChamado,
  type ClienteEscrita,
} from './ferramentas';
import {
  lerArquivosLocais,
  motivoCaminhoSensivel,
  expandirCaminho,
  nomeExibicao,
  parsearDirsAnexos,
  TAMANHO_MAX_ARQUIVO_ENVIO,
  type FsLeitura,
} from './arquivos-locais';
import type { ArquivoBaixado } from '@chamados/cliente-api';

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

  it('meus (D-037): só viaja quando true', () => {
    expect(montarQueryListar({ meus: true }).meus).toBe('true');
    expect(montarQueryListar({ meus: false }).meus).toBeUndefined();
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

describe('montarCorpoStatus (D-043)', () => {
  it('sem custo: só status e motivo', () => {
    expect(montarCorpoStatus({ status: 'em_atendimento' })).toEqual({
      ok: true,
      corpo: { status: 'em_atendimento' },
    });
  });

  it('custo_final viaja junto de "resolvido" (inclusive 0)', () => {
    expect(montarCorpoStatus({ status: 'resolvido', custo_final: 150.5, motivo: 'ok' })).toEqual({
      ok: true,
      corpo: { status: 'resolvido', motivo: 'ok', custo_final: 150.5 },
    });
    expect(montarCorpoStatus({ status: 'resolvido', custo_final: 0 })).toEqual({
      ok: true,
      corpo: { status: 'resolvido', custo_final: 0 },
    });
  });

  it('custo_final em outra transição é recusado antes da API', () => {
    expect(montarCorpoStatus({ status: 'fechado', custo_final: 10 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Envio de arquivos locais (D-046) — tmpdir real como "home"
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('arquivos locais — regras puras', () => {
  const home = '/home/ana';

  it('expande ~ e exige caminho absoluto', () => {
    expect(expandirCaminho('~/prints/a.png', home)).toBe('/home/ana/prints/a.png');
    expect(expandirCaminho('~', home)).toBe(home);
    expect(expandirCaminho('prints/a.png', home)).toBeNull();
    expect(expandirCaminho('/tmp/../tmp/a.png', home)).toBe('/tmp/a.png');
  });

  it('recusa caminhos sensíveis óbvios', () => {
    const sensiveis = [
      '/home/ana/.ssh/id_rsa',
      '/home/ana/.ssh/config',
      '/home/ana/.aws/credentials',
      '/home/ana/.gnupg/pubring.kbx',
      '/home/ana/.local/share/keyrings/login.keyring',
      '/home/ana/projeto/.env',
      '/home/ana/projeto/.env.local',
      '/home/ana/projeto/producao.env',
      '/home/ana/chaves/id_ed25519',
      '/home/ana/chaves/id_ed25519.pub',
      '/home/ana/certs/servidor.pem',
      '/home/ana/certs/servidor.key',
      '/home/ana/.netrc',
      '/home/ana/.git-credentials',
      '/home/ana/.claude.json',
      '/home/ana/.claude/settings.json',
      '/home/ana/projeto/.mcp.json',
      '/mnt/backup/.ssh/id_rsa',
      '/etc/passwd',
      '/proc/self/environ',
    ];
    for (const c of sensiveis) expect(motivoCaminhoSensivel(c, home), c).not.toBeNull();
  });

  it('deixa passar prints e relatórios comuns', () => {
    for (const c of [
      '/home/ana/prints/erro.png',
      '/home/ana/Downloads/relatorio.pdf',
      '/tmp/forja/execucao-1/id_cliente.png',
      '/home/ana/projeto/logs/app.log',
    ]) {
      expect(motivoCaminhoSensivel(c, home), c).toBeNull();
    }
  });

  it('nome de exibição: basename sem controles; vazio cai no do disco', () => {
    expect(nomeExibicao('../../x/tela.png', 'a.png')).toBe('tela.png');
    expect(nomeExibicao(undefined, 'a.png')).toBe('a.png');
    expect(nomeExibicao('  ', 'a.png')).toBe('a.png');
    expect(nomeExibicao('t\u0007ela.png', 'a.png')).toBe('tela.png');
  });

  it('CHAMADOS_MCP_DIR_ANEXOS: lista por delimitador; relativo é erro', () => {
    expect(parsearDirsAnexos(undefined, home)).toEqual({ ok: true, dirs: null });
    expect(parsearDirsAnexos(`~/prints${path.delimiter}/tmp/forja`, home)).toEqual({
      ok: true,
      dirs: ['/home/ana/prints', '/tmp/forja'],
    });
    expect(parsearDirsAnexos('prints', home).ok).toBe(false);
  });
});

describe('arquivos locais — leitura do disco (tmpdir)', () => {
  let home = '';
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'mcp-envio-'));
    await mkdir(path.join(home, '.ssh'));
    await mkdir(path.join(home, 'prints'));
    await mkdir(path.join(home, 'outros'));
    await writeFile(path.join(home, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----');
    await writeFile(path.join(home, 'prints', 'tela.png'), PNG_BYTES);
    await writeFile(path.join(home, 'prints', 'vazio.png'), '');
    await writeFile(path.join(home, 'outros', 'r.pdf'), '%PDF-1.4 x');
    // Link "inocente" para a chave: o destino real é checado.
    await symlink(path.join(home, '.ssh', 'id_rsa'), path.join(home, 'prints', 'log.txt'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lê os arquivos, com ~ e nome de exibição', async () => {
    const r = await lerArquivosLocais(
      ['~/prints/tela.png', { caminho: path.join(home, 'outros', 'r.pdf'), nome: 'Relatório.pdf' }],
      { dirsPermitidos: null, home },
    );
    if (!r.ok) throw new Error(r.erro);
    expect(r.arquivos.map((a) => a.nome)).toEqual(['tela.png', 'Relatório.pdf']);
    expect(Buffer.from(r.arquivos[0]!.conteudo).equals(PNG_BYTES)).toBe(true);
  });

  it('recusa com mensagem clara: inexistente, diretório, vazio, relativo', async () => {
    const casos: Array<[string, string]> = [
      [path.join(home, 'prints', 'nao-existe.png'), 'não encontrado'],
      [path.join(home, 'prints'), 'diretório'],
      [path.join(home, 'prints', 'vazio.png'), 'vazio'],
      ['prints/tela.png', 'ABSOLUTO'],
    ];
    for (const [c, trecho] of casos) {
      const r = await lerArquivosLocais([c], { dirsPermitidos: null, home });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.erro).toContain(trecho);
        expect(r.erro).toContain('Nada foi enviado');
      }
    }
  });

  it('recusa a chave SSH — direto e por symlink com nome inocente', async () => {
    const direto = await lerArquivosLocais(['~/.ssh/id_rsa'], { dirsPermitidos: null, home });
    expect(direto.ok).toBe(false);
    const link = await lerArquivosLocais([path.join(home, 'prints', 'log.txt')], {
      dirsPermitidos: null,
      home,
    });
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.erro).toContain('link');
  });

  it('o nome de exibição não troca a extensão (disfarce de .env/.pdf como .txt)', async () => {
    const r = await lerArquivosLocais(
      [{ caminho: path.join(home, 'outros', 'r.pdf'), nome: 'notas.txt' }],
      { dirsPermitidos: null, home },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain('extensão');
  });

  it('CHAMADOS_MCP_DIR_ANEXOS restringe pelos caminhos REAIS', async () => {
    const dentro = await lerArquivosLocais(['~/prints/tela.png'], {
      dirsPermitidos: [path.join(home, 'prints')],
      home,
    });
    expect(dentro.ok).toBe(true);
    const fora = await lerArquivosLocais([path.join(home, 'outros', 'r.pdf')], {
      dirsPermitidos: [path.join(home, 'prints')],
      home,
    });
    expect(fora.ok).toBe(false);
    if (!fora.ok) expect(fora.erro).toContain('CHAMADOS_MCP_DIR_ANEXOS');
    // `..` não escapa: normalizado antes de comparar.
    const escape = await lerArquivosLocais([path.join(home, 'prints', '..', 'outros', 'r.pdf')], {
      dirsPermitidos: [path.join(home, 'prints')],
      home,
    });
    expect(escape.ok).toBe(false);
  });

  it('um arquivo ruim recusa TODOS (nada é lido para envio)', async () => {
    const r = await lerArquivosLocais(['~/prints/tela.png', '~/.ssh/id_rsa'], {
      dirsPermitidos: null,
      home,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain('arquivo 2');
  });

  it('acima de 25 MB, ou soma acima do teto, recusa ANTES de ler os bytes', async () => {
    const lidos: string[] = [];
    const fsFake: FsLeitura = {
      realpath: async (p) => p,
      stat: async (p) => ({
        isFile: () => true,
        isDirectory: () => false,
        size: p.includes('grande') ? TAMANHO_MAX_ARQUIVO_ENVIO + 1 : 20 * 1024 * 1024,
      }),
      readFile: async (p) => {
        lidos.push(p);
        return Buffer.from('x');
      },
    };
    const grande = await lerArquivosLocais(['/dados/grande.png'], {
      dirsPermitidos: null,
      home,
      fs: fsFake,
    });
    expect(grande.ok).toBe(false);
    if (!grande.ok) expect(grande.erro).toContain('25.0 MB');
    const soma = await lerArquivosLocais(['/dados/a.png', '/dados/b.png'], {
      dirsPermitidos: null,
      home,
      fs: fsFake,
    });
    expect(soma.ok).toBe(false);
    if (!soma.ok) expect(soma.erro).toContain('somam');
    expect(lidos).toEqual([]);
  });

  it('mais de 20 arquivos → recusa', async () => {
    const r = await lerArquivosLocais(
      Array.from({ length: 21 }, () => '~/prints/tela.png'),
      { dirsPermitidos: null, home },
    );
    expect(r.ok).toBe(false);
  });

  describe('montagem da chamada', () => {
    function clienteFake() {
      const chamadas: Array<{ metodo: string; args: unknown[] }> = [];
      const cliente = {
        requisitar: async (...args: unknown[]) => {
          chamadas.push({ metodo: 'requisitar', args });
          return { id: 'json' };
        },
        publicarMensagemComArquivos: async (...args: unknown[]) => {
          chamadas.push({ metodo: 'publicarMensagemComArquivos', args });
          return { id: 'm1', anexos: [{ id: 'a1', nome_arquivo: 'tela.png', inline: true }] };
        },
        criarChamadoComImagens: async (...args: unknown[]) => {
          chamadas.push({ metodo: 'criarChamadoComImagens', args });
          return { id: 'c1', numero: 3, anexos: [] };
        },
      } as unknown as ClienteEscrita;
      return { cliente, chamadas };
    }

    it('sem arquivos: o JSON de sempre; corpo vazio é recusado localmente', async () => {
      const { cliente, chamadas } = clienteFake();
      await executarPublicarMensagem(
        cliente,
        { ref: '12', visibilidade: 'interna', corpo: 'nota' },
        { dirsAnexos: null },
      );
      expect(chamadas[0]).toEqual({
        metodo: 'requisitar',
        args: [
          '/api/v1/chamados/12/mensagens',
          { metodo: 'POST', corpo: { visibilidade: 'interna', corpo: 'nota' } },
        ],
      });
      const vazio = await executarPublicarMensagem(
        cliente,
        { ref: '12', visibilidade: 'interna' },
        { dirsAnexos: null },
      );
      expect(vazio.isError).toBe(true);
      expect(chamadas).toHaveLength(1);
    });

    it('com arquivos: lê do disco e chama o multipart; retorno lista os anexos', async () => {
      const { cliente, chamadas } = clienteFake();
      const r = await executarPublicarMensagem(
        cliente,
        { ref: ' #12 ', visibilidade: 'publica', arquivos: ['~/prints/tela.png'] },
        { dirsAnexos: null, leitura: { home } },
      );
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.type === 'text' && r.content[0]!.text).toContain('"inline": true');
      const c = chamadas[0]!;
      expect(c.metodo).toBe('publicarMensagemComArquivos');
      const [ref, entrada] = c.args as [
        string,
        { corpo: string; arquivos: Array<{ nome: string }> },
      ];
      expect(ref).toBe('#12');
      expect(entrada.corpo).toBe('');
      expect(entrada.arquivos.map((a) => a.nome)).toEqual(['tela.png']);
    });

    it('arquivo recusado: erro da ferramenta e NENHUMA chamada à API', async () => {
      const { cliente, chamadas } = clienteFake();
      const r = await executarPublicarMensagem(
        cliente,
        { ref: '12', visibilidade: 'publica', corpo: 'x', arquivos: ['~/.ssh/id_rsa'] },
        { dirsAnexos: null, leitura: { home } },
      );
      expect(r.isError).toBe(true);
      expect(chamadas).toEqual([]);
    });

    it('chamado_criar com imagens usa o multipart da criação', async () => {
      const { cliente, chamadas } = clienteFake();
      await executarCriarChamado(
        cliente,
        { titulo: 'Tela', descricao: 'Veja', arquivos: ['~/prints/tela.png'] },
        { dirsAnexos: null, leitura: { home } },
      );
      expect(chamadas[0]!.metodo).toBe('criarChamadoComImagens');
      expect(chamadas[0]!.args[0]).toEqual({ titulo: 'Tela', descricao: 'Veja' });
    });
  });
});
