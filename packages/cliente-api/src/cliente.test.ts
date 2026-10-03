import { describe, it, expect } from 'vitest';
import {
  ClienteChamados,
  nomeDoContentDisposition,
  queryDeFiltros,
  type ConfigCliente,
  type FetchImpl,
} from './cliente';
import { ErroApi, ErroRede } from './erros';
import { ArmazenamentoTokenMemoria, type ArmazenamentoToken } from './armazenamento-token';

/**
 * Cliente HTTP da API (specs/forja/01 §5.2; 07 §2.2): sessão preguiçosa, Bearer em
 * toda chamada, renovação 1× em 401 (single-flight), token injetável, prazo por
 * requisição e métodos tipados. A fronteira de rede (`fetch`) é injetada — nada
 * aqui sobe a aplicação nem toca a rede.
 */

const SENHA = 'senha-secreta';
const CFG: ConfigCliente = {
  baseUrl: 'https://suporte.exemplo.com',
  email: 'op@exemplo.com',
  obterSenha: () => SENHA,
  tenantSlug: null,
};

interface Chamada {
  url: string;
  init: RequestInit | undefined;
}

/** `fetch` fake que registra as chamadas e devolve respostas roteirizadas. */
function fakeFetch(rotas: (chamada: Chamada, n: number) => Response | Promise<Response>): {
  impl: FetchImpl;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  const impl: FetchImpl = (url, init) => {
    chamadas.push({ url, init });
    return Promise.resolve(rotas({ url, init }, chamadas.length));
  };
  return { impl, chamadas };
}

function json(dados: unknown, status = 200): Response {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SESSAO_OK = {
  token: 'tok-1',
  expira_em: '2026-10-02T20:00:00.000Z',
  usuario: { id: 'u1', nome: 'Op', email: 'op@exemplo.com', papel: 'operador' },
  tenant: { slug: 'acme', nome_exibicao: 'ACME' },
};

const ehLogin = (c: Chamada): boolean =>
  c.url.endsWith('/api/v1/sessao') && c.init?.method === 'POST';
const logins = (cs: Chamada[]): Chamada[] => cs.filter(ehLogin);
const auth = (c: Chamada): string | undefined =>
  (c.init?.headers as Record<string, string> | undefined)?.authorization;

/** Armazenamento espião (o que a Forja injetaria com SQLite cifrado). */
class ArmazenamentoEspiao implements ArmazenamentoToken {
  gravados: Array<[string, string]> = [];
  limpezas = 0;
  constructor(public token: string | null = null) {}
  async ler(): Promise<string | null> {
    return this.token;
  }
  async gravar(token: string, expiraEm: string): Promise<void> {
    this.token = token;
    this.gravados.push([token, expiraEm]);
  }
  async limpar(): Promise<void> {
    this.token = null;
    this.limpezas += 1;
  }
}

describe('ClienteChamados — sessão', () => {
  it('autentica na PRIMEIRA requisição e envia o token como Bearer', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await cliente.requisitar('/api/v1/chamados');

    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]!.url).toBe('https://suporte.exemplo.com/api/v1/sessao');
    expect(JSON.parse(chamadas[0]!.init?.body as string)).toEqual({
      email: 'op@exemplo.com',
      senha: SENHA,
    });
    expect(auth(chamadas[1]!)).toBe('Bearer tok-1');
    expect(cliente.quemSou()).toEqual({
      id: 'u1',
      nome: 'Op',
      email: 'op@exemplo.com',
      papel: 'operador',
      tenant: 'ACME',
      tenantSlug: 'acme',
      expiraEm: SESSAO_OK.expira_em,
    });
  });

  it('reaproveita a sessão nas requisições seguintes (um login só)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ ok: true }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await cliente.requisitar('/api/v1/chamados');
    await cliente.requisitar('/api/v1/chamados/1');

    expect(logins(chamadas)).toHaveLength(1);
  });

  it('logins concorrentes viram UM só (single-flight)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ ok: true }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await Promise.all([
      cliente.requisitar('/api/v1/chamados'),
      cliente.requisitar('/api/v1/sistemas-alvo'),
      cliente.requisitar('/api/v1/chamados/1'),
    ]);

    expect(logins(chamadas)).toHaveLength(1);
  });

  it('renova a sessão UMA vez ao receber 401 e repete a requisição', async () => {
    let n = 0;
    const { impl, chamadas } = fakeFetch((c) => {
      if (ehLogin(c)) {
        n += 1;
        return json({ ...SESSAO_OK, token: n === 1 ? 'tok-1' : 'tok-2' });
      }
      if (auth(c) !== 'Bearer tok-2') {
        return json({ erro: 'Sessão expirada.', codigo: 'nao_autenticado' }, 401);
      }
      return json({ itens: ['ok'] });
    });
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    const r = await cliente.requisitar<{ itens: string[] }>('/api/v1/chamados');

    expect(r.itens).toEqual(['ok']);
    expect(logins(chamadas)).toHaveLength(2);
  });

  it('401 simultâneos com o mesmo token disparam UM relogin', async () => {
    let n = 0;
    const { impl, chamadas } = fakeFetch((c) => {
      if (ehLogin(c)) {
        n += 1;
        return json({ ...SESSAO_OK, token: `tok-novo-${n}` });
      }
      return auth(c) === 'Bearer tok-velho'
        ? json({ erro: 'Sessão expirada.', codigo: 'nao_autenticado' }, 401)
        : json({ ok: true });
    });
    const cliente = new ClienteChamados(CFG, {
      fetch: impl,
      armazenamento: new ArmazenamentoEspiao('tok-velho'),
    });

    await Promise.all([
      cliente.requisitar('/api/v1/chamados'),
      cliente.requisitar('/api/v1/chamados/1'),
      cliente.requisitar('/api/v1/chamados/2'),
    ]);

    expect(logins(chamadas)).toHaveLength(1);
  });

  it('desiste após o segundo 401 (credencial errada de verdade)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c)
        ? json(SESSAO_OK)
        : json({ erro: 'Sessão inválida.', codigo: 'nao_autenticado' }, 401),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toBeInstanceOf(ErroApi);
    expect(logins(chamadas)).toHaveLength(2);
  });

  it('preserva status e CÓDIGO do contrato no erro', async () => {
    const { impl } = fakeFetch((c) =>
      ehLogin(c)
        ? json(SESSAO_OK)
        : json({ erro: 'Transição não permitida.', codigo: 'transicao_invalida' }, 409),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    const erro = await cliente.requisitar('/api/v1/chamados/1/status').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroApi);
    expect((erro as ErroApi).codigo).toBe('transicao_invalida');
    expect((erro as ErroApi).status).toBe(409);
  });

  it('corpo de erro não-JSON vira código http_<status>', async () => {
    const { impl } = fakeFetch((c) =>
      ehLogin(c)
        ? json(SESSAO_OK)
        : new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toMatchObject({
      status: 502,
      codigo: 'http_502',
    });
  });

  it('nunca expõe a senha na mensagem de erro do login', async () => {
    const { impl } = fakeFetch(() =>
      json({ erro: 'E-mail ou senha inválidos.', codigo: 'credenciais_invalidas' }, 401),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    const erro = (await cliente.requisitar('/api/v1/chamados').catch((e: unknown) => e)) as ErroApi;
    expect(erro.message).not.toContain(SENHA);
    expect(erro.codigo).toBe('credenciais_invalidas');
  });

  it('obtém a senha de forma assíncrona (keyring da Forja)', async () => {
    const { impl, chamadas } = fakeFetch((c) => (ehLogin(c) ? json(SESSAO_OK) : json({})));
    const cliente = new ClienteChamados(
      { ...CFG, obterSenha: () => Promise.resolve('do-keyring') },
      { fetch: impl },
    );
    await cliente.requisitar('/api/v1/chamados');
    expect(JSON.parse(chamadas[0]!.init?.body as string).senha).toBe('do-keyring');
  });

  it('envia o slug do tenant quando configurado (host que não resolve — dev)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(
      { ...CFG, baseUrl: 'http://localhost:3000', tenantSlug: 'acme' },
      { fetch: impl },
    );

    await cliente.requisitar('/api/v1/chamados');

    for (const c of chamadas) {
      expect((c.init?.headers as Record<string, string>)['x-tenant-slug']).toBe('acme');
    }
  });

  it('monta a query string ignorando parâmetros vazios', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await cliente.requisitar('/api/v1/chamados', {
      query: { status: 'novo,em_triagem', busca: undefined, cursor: '' },
    });

    const url = new URL(chamadas[1]!.url);
    expect(url.searchParams.get('status')).toBe('novo,em_triagem');
    expect(url.searchParams.has('busca')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('trata 204 sem tentar parsear JSON', async () => {
    const { impl } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : new Response(null, { status: 204 }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await expect(
      cliente.requisitar('/api/v1/sessao', { metodo: 'DELETE' }),
    ).resolves.toBeUndefined();
  });

  it('2xx com corpo ilegível vira ErroApi resposta_invalida (não erro de rede)', async () => {
    const { impl } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : new Response('ok?', { status: 200 }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });

    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toMatchObject({
      codigo: 'resposta_invalida',
    });
  });
});

describe('ClienteChamados — armazenamento do token', () => {
  it('reaproveita o token persistido SEM login (reinício da Forja)', async () => {
    const arm = new ArmazenamentoEspiao('tok-salvo');
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl, armazenamento: arm });

    await cliente.requisitar('/api/v1/chamados');

    expect(logins(chamadas)).toHaveLength(0);
    expect(auth(chamadas[0]!)).toBe('Bearer tok-salvo');
    expect(cliente.quemSou()).toBeNull();
  });

  it('grava o token do login com a expiração', async () => {
    const arm = new ArmazenamentoEspiao();
    const { impl } = fakeFetch((c) => (ehLogin(c) ? json(SESSAO_OK) : json({})));
    const cliente = new ClienteChamados(CFG, { fetch: impl, armazenamento: arm });

    await cliente.requisitar('/api/v1/chamados');

    expect(arm.gravados).toEqual([['tok-1', SESSAO_OK.expira_em]]);
  });

  it('token persistido recusado (401) é apagado e substituído pelo novo', async () => {
    const arm = new ArmazenamentoEspiao('tok-velho');
    const { impl } = fakeFetch((c) =>
      ehLogin(c)
        ? json({ ...SESSAO_OK, token: 'tok-novo' })
        : auth(c) === 'Bearer tok-novo'
          ? json({ ok: true })
          : json({ erro: 'Sessão expirada.', codigo: 'nao_autenticado' }, 401),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl, armazenamento: arm });

    await cliente.requisitar('/api/v1/chamados');

    expect(arm.limpezas).toBe(1);
    expect(arm.token).toBe('tok-novo');
  });

  it('encerrarSessao faz DELETE com o token e apaga o armazenado', async () => {
    const arm = new ArmazenamentoEspiao('tok-salvo');
    const { impl, chamadas } = fakeFetch(() => new Response(null, { status: 204 }));
    const cliente = new ClienteChamados(CFG, { fetch: impl, armazenamento: arm });

    await cliente.encerrarSessao();

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.init?.method).toBe('DELETE');
    expect(auth(chamadas[0]!)).toBe('Bearer tok-salvo');
    expect(arm.token).toBeNull();
  });

  it('encerrarSessao sem token não chama a rede', async () => {
    const { impl, chamadas } = fakeFetch(() => json({}));
    const cliente = new ClienteChamados(CFG, { fetch: impl });
    await cliente.encerrarSessao();
    expect(chamadas).toHaveLength(0);
  });

  it('ArmazenamentoTokenMemoria guarda, informa a expiração e limpa', async () => {
    const arm = new ArmazenamentoTokenMemoria();
    expect(await arm.ler()).toBeNull();
    await arm.gravar('t', '2026-01-01T00:00:00.000Z');
    expect(await arm.ler()).toBe('t');
    expect(arm.expiracao()).toBe('2026-01-01T00:00:00.000Z');
    await arm.limpar();
    expect(await arm.ler()).toBeNull();
  });
});

describe('ClienteChamados — sessão já aberta (tokenInicial, FJ-030 §4)', () => {
  const SO_TOKEN: ConfigCliente = {
    baseUrl: 'https://suporte.exemplo.com',
    email: 'op@exemplo.com',
    tenantSlug: null,
    tokenInicial: 'tok-da-forja',
  };
  const recusa = (): Response => json({ erro: 'Sessão expirada.', codigo: 'nao_autenticado' }, 401);

  it('usa o token inicial como Bearer, SEM login', async () => {
    const { impl, chamadas } = fakeFetch(() => json({ itens: [] }));
    const cliente = new ClienteChamados(SO_TOKEN, { fetch: impl });

    await cliente.requisitar('/api/v1/chamados');
    await cliente.requisitar('/api/v1/sistemas-alvo');

    expect(logins(chamadas)).toHaveLength(0);
    expect(chamadas.map(auth)).toEqual(['Bearer tok-da-forja', 'Bearer tok-da-forja']);
    expect(cliente.quemSou()).toBeNull();
  });

  it('o token persistido não sobrepõe o inicial', async () => {
    const arm = new ArmazenamentoEspiao('tok-salvo');
    const { impl, chamadas } = fakeFetch(() => json({}));
    const cliente = new ClienteChamados(SO_TOKEN, { fetch: impl, armazenamento: arm });

    await cliente.requisitar('/api/v1/chamados');

    expect(auth(chamadas[0]!)).toBe('Bearer tok-da-forja');
  });

  it('token recusado e SEM senha → ErroApi 401 claro, sem tentar login nem vazar o token', async () => {
    const { impl, chamadas } = fakeFetch(recusa);
    const cliente = new ClienteChamados(SO_TOKEN, { fetch: impl });

    const erro = await cliente.requisitar('/api/v1/chamados').catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ErroApi);
    expect(erro).toMatchObject({ status: 401, codigo: 'sessao_recusada' });
    expect((erro as Error).message).toMatch(/token de sessão/);
    expect((erro as Error).message).not.toContain('tok-da-forja');
    expect(logins(chamadas)).toHaveLength(0);
    expect(chamadas).toHaveLength(1);

    // As chamadas seguintes falham igual, sem ir à rede com o token morto.
    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toMatchObject({
      codigo: 'sessao_recusada',
    });
    expect(chamadas).toHaveLength(1);
  });

  it('sem token e sem senha → o mesmo erro, sem rede', async () => {
    const { impl, chamadas } = fakeFetch(() => json({}));
    const cliente = new ClienteChamados({ ...SO_TOKEN, tokenInicial: '   ' }, { fetch: impl });

    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toMatchObject({
      status: 401,
      codigo: 'sessao_recusada',
    });
    expect(chamadas).toHaveLength(0);
  });

  it('token recusado COM senha → reloga uma vez e segue com o token novo', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c) ? json(SESSAO_OK) : auth(c) === 'Bearer tok-1' ? json({ ok: true }) : recusa(),
    );
    const cliente = new ClienteChamados({ ...SO_TOKEN, obterSenha: () => SENHA }, { fetch: impl });

    await expect(cliente.requisitar('/api/v1/chamados')).resolves.toEqual({ ok: true });

    expect(logins(chamadas)).toHaveLength(1);
    expect(auth(chamadas[0]!)).toBe('Bearer tok-da-forja');
    expect(auth(chamadas[2]!)).toBe('Bearer tok-1');
  });
});

describe('ClienteChamados — prazo e cancelamento', () => {
  /** `fetch` que só termina quando abortado (servidor mudo). */
  const fetchMudo: FetchImpl = (_url, init) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () =>
        rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
      );
    });

  it('estoura o prazo com ErroRede("timeout")', async () => {
    const arm = new ArmazenamentoEspiao('tok');
    const cliente = new ClienteChamados(
      { ...CFG, timeoutMs: 20 },
      { fetch: fetchMudo, armazenamento: arm },
    );

    const erro = await cliente.requisitar('/api/v1/chamados').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroRede);
    expect((erro as ErroRede).codigo).toBe('timeout');
  });

  it('prazo por chamada sobrepõe o padrão; o login também tem prazo', async () => {
    const cliente = new ClienteChamados({ ...CFG, timeoutMs: 20 }, { fetch: fetchMudo });
    await expect(cliente.listarSistemasAlvo()).rejects.toMatchObject({ codigo: 'timeout' });

    const outro = new ClienteChamados(CFG, {
      fetch: fetchMudo,
      armazenamento: new ArmazenamentoEspiao('tok'),
    });
    await expect(outro.listarSistemasAlvo({ timeoutMs: 20 })).rejects.toMatchObject({
      codigo: 'timeout',
    });
  });

  it('sinal de quem chamou cancela com ErroRede("abortado")', async () => {
    const cliente = new ClienteChamados(CFG, {
      fetch: fetchMudo,
      armazenamento: new ArmazenamentoEspiao('tok'),
    });
    const ctrl = new AbortController();
    const p = cliente.requisitar('/api/v1/chamados', { sinal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'ErroRede', codigo: 'abortado' });
  });

  it('falha de rede vira ErroRede("rede") sem vazar a senha', async () => {
    const cliente = new ClienteChamados(CFG, {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const erro = (await cliente
      .requisitar('/api/v1/chamados')
      .catch((e: unknown) => e)) as ErroRede;
    expect(erro).toBeInstanceOf(ErroRede);
    expect(erro.codigo).toBe('rede');
    expect(erro.message).not.toContain(SENHA);
  });
});

describe('ClienteChamados — métodos tipados', () => {
  function clienteCom(resposta: (c: Chamada) => Response) {
    const { impl, chamadas } = fakeFetch((c) => resposta(c));
    const cliente = new ClienteChamados(CFG, {
      fetch: impl,
      armazenamento: new ArmazenamentoEspiao('tok'),
    });
    return { cliente, chamadas };
  }

  it('queryDeFiltros: listas viram CSV e números viram texto', () => {
    expect(
      queryDeFiltros({
        status: ['em_atendimento', 'aguardando_cliente'],
        natureza: 'alteracao',
        limite: 100,
        complexidade: ['facil', 'medio'],
        atribuicao: 'nao_atribuido',
      }),
    ).toMatchObject({
      status: 'em_atendimento,aguardando_cliente',
      natureza: 'alteracao',
      limite: '100',
      complexidade: 'facil,medio',
      atribuicao: 'nao_atribuido',
      cursor: undefined,
    });
    expect(queryDeFiltros({ status: 'novo' }).status).toBe('novo');
    expect(queryDeFiltros({ status: [] }).status).toBeUndefined();
  });

  it('listarTodosChamados pagina até proximo_cursor = null', async () => {
    const { cliente, chamadas } = clienteCom((c) => {
      const cursor = new URL(c.url).searchParams.get('cursor');
      if (!cursor) return json({ itens: [{ id: 'a' }], proximo_cursor: 'c1' });
      if (cursor === 'c1') return json({ itens: [{ id: 'b' }], proximo_cursor: 'c2' });
      return json({ itens: [{ id: 'c' }], proximo_cursor: null });
    });

    const itens = await cliente.listarTodosChamados({ status: ['em_atendimento'], limite: 100 });

    expect(itens.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(chamadas).toHaveLength(3);
    expect(new URL(chamadas[0]!.url).searchParams.get('status')).toBe('em_atendimento');
  });

  it('listarTodosChamados para em cursor repetido e em maxPaginas', async () => {
    const { cliente, chamadas } = clienteCom(() =>
      json({ itens: [{ id: 'x' }], proximo_cursor: 'sempre' }),
    );
    await cliente.listarTodosChamados();
    expect(chamadas).toHaveLength(2);

    const outro = clienteCom((c) =>
      json({ itens: [], proximo_cursor: `c${new URL(c.url).searchParams.get('cursor') ?? ''}x` }),
    );
    await outro.cliente.listarTodosChamados({}, { maxPaginas: 3 });
    expect(outro.chamadas).toHaveLength(3);
  });

  it('obterChamado codifica o ref e envia o formato', async () => {
    const { cliente, chamadas } = clienteCom(() =>
      json({
        chamado: { id: 'u', numero: 12, reaberto_count: 0, fechar_automaticamente_em: null },
        mensagens: [],
      }),
    );
    const r = await cliente.obterChamado('#12', { formato: 'markdown' });
    expect(chamadas[0]!.url).toBe(
      'https://suporte.exemplo.com/api/v1/chamados/%2312?formato=markdown',
    );
    expect(r.chamado.numero).toBe(12);
  });

  it('escritas: rota, método e corpo de cada endpoint', async () => {
    const { cliente, chamadas } = clienteCom(() => json({ id: 'm1' }, 201));
    await cliente.publicarMensagem('u1', { visibilidade: 'interna', corpo: 'nota' });
    await cliente.mudarStatus('u1', { status: 'resolvido', motivo: 'via_forja' });
    await cliente.criarChamado({ titulo: 'T', descricao: 'D', natureza: 'problema' });
    await cliente.definirSilencioIa('u1', true);
    await cliente.atribuir('u1', null);

    const ver = chamadas.map((c) => [
      c.init?.method,
      new URL(c.url).pathname,
      JSON.parse(c.init?.body as string),
    ]);
    expect(ver).toEqual([
      ['POST', '/api/v1/chamados/u1/mensagens', { visibilidade: 'interna', corpo: 'nota' }],
      ['POST', '/api/v1/chamados/u1/status', { status: 'resolvido', motivo: 'via_forja' }],
      ['POST', '/api/v1/chamados', { titulo: 'T', descricao: 'D', natureza: 'problema' }],
      ['POST', '/api/v1/chamados/u1/ia', { silenciada: true }],
      ['POST', '/api/v1/chamados/u1/atribuicao', { operador_id: null }],
    ]);
    for (const c of chamadas) {
      expect((c.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    }
  });

  it('listarSistemasAlvo faz GET em /api/v1/sistemas-alvo', async () => {
    const { cliente, chamadas } = clienteCom(() =>
      json({
        sistemas: [{ id: 's', nome: 'ERP', descricao: null }],
        sistema_alvo_obrigatorio: false,
      }),
    );
    const r = await cliente.listarSistemasAlvo();
    expect(new URL(chamadas[0]!.url).pathname).toBe('/api/v1/sistemas-alvo');
    expect(r.sistemas[0]!.nome).toBe('ERP');
  });
});

describe('anexos — baixarAnexo / requisitarBytes / nomeDoContentDisposition', () => {
  it('devolve os bytes, o tipo pinado e o nome UTF-8 do Content-Disposition', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      ehLogin(c)
        ? json(SESSAO_OK)
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              'content-type': 'image/png; charset=binary',
              'content-disposition': `inline; filename="tela.png"; filename*=UTF-8''tela%20%C3%A9.png`,
            },
          }),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });
    const r = await cliente.baixarAnexo('abc');
    expect(new URL(chamadas[1]!.url).pathname).toBe('/api/v1/anexos/abc');
    expect([...r.corpo]).toEqual([1, 2, 3]);
    expect(r.contentType).toBe('image/png');
    expect(r.nomeArquivo).toBe('tela é.png');
  });

  it('erro da API em bytes vira ErroApi com o código', async () => {
    const { impl } = fakeFetch((c) =>
      ehLogin(c)
        ? json(SESSAO_OK)
        : json({ erro: 'Anexo não encontrado.', codigo: 'anexo_inexistente' }, 404),
    );
    const cliente = new ClienteChamados(CFG, { fetch: impl });
    await expect(cliente.requisitarBytes('/api/v1/anexos/x')).rejects.toMatchObject({
      codigo: 'anexo_inexistente',
      status: 404,
    });
  });

  it('nomeDoContentDisposition cai no filename ASCII e tolera ausência', () => {
    expect(nomeDoContentDisposition('attachment; filename="a.pdf"')).toBe('a.pdf');
    expect(nomeDoContentDisposition(null)).toBeNull();
  });
});
