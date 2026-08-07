import { describe, it, expect } from 'vitest';
import { ClienteChamados, ErroApi, type FetchImpl } from './cliente';
import type { ConfigMcp } from './config';

/**
 * Cliente HTTP do MCP (specs/11 §7.1): sessão preguiçosa, Bearer em toda chamada
 * e renovação automática em 401. A fronteira de rede (`fetch`) é injetada — os
 * testes provam o comportamento sem subir a aplicação.
 */

const CFG: ConfigMcp = {
  baseUrl: 'https://suporte.exemplo.com',
  email: 'op@exemplo.com',
  senha: 'senha-secreta',
  tenantSlug: null,
  somenteLeitura: false,
};

interface Chamada {
  url: string;
  init: RequestInit | undefined;
}

/** `fetch` fake que registra as chamadas e devolve respostas roteirizadas. */
function fakeFetch(rotas: (chamada: Chamada, n: number) => Response): {
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
  usuario: { id: 'u1', nome: 'Op', email: 'op@exemplo.com', papel: 'operador' },
  tenant: { slug: 'acme', nome_exibicao: 'ACME' },
};

describe('ClienteChamados', () => {
  it('autentica na PRIMEIRA requisição e envia o token como Bearer', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao') ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(CFG, impl);

    await cliente.requisitar('/api/v1/chamados');

    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]!.url).toBe('https://suporte.exemplo.com/api/v1/sessao');
    expect(chamadas[0]!.init?.method).toBe('POST');
    const headers = chamadas[1]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(cliente.quemSou()).toEqual({
      nome: 'Op',
      email: 'op@exemplo.com',
      papel: 'operador',
      tenant: 'ACME',
    });
  });

  it('reaproveita a sessão nas requisições seguintes (um login só)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao') ? json(SESSAO_OK) : json({ ok: true }),
    );
    const cliente = new ClienteChamados(CFG, impl);

    await cliente.requisitar('/api/v1/chamados');
    await cliente.requisitar('/api/v1/chamados/1');

    const logins = chamadas.filter((c) => c.url.endsWith('/api/v1/sessao'));
    expect(logins).toHaveLength(1);
  });

  it('renova a sessão UMA vez ao receber 401 e repete a requisição', async () => {
    let logins = 0;
    const { impl, chamadas } = fakeFetch((c) => {
      if (c.url.endsWith('/api/v1/sessao')) {
        // 1º login devolve um token já expirado; só o 2º devolve o válido.
        logins += 1;
        return json({ ...SESSAO_OK, token: logins === 1 ? 'tok-1' : 'tok-2' });
      }
      const headers = c.init?.headers as Record<string, string>;
      // O primeiro token está "expirado": só o renovado é aceito.
      if (headers.authorization !== 'Bearer tok-2') {
        return json({ erro: 'Sessão expirada.', codigo: 'nao_autenticado' }, 401);
      }
      return json({ itens: ['ok'] });
    });
    const cliente = new ClienteChamados({ ...CFG }, impl);

    const r = await cliente.requisitar<{ itens: string[] }>('/api/v1/chamados');

    expect(r.itens).toEqual(['ok']);
    // login inicial → 401 → novo login → repetição bem-sucedida
    expect(chamadas.filter((c) => c.url.endsWith('/api/v1/sessao'))).toHaveLength(2);
  });

  it('desiste após o segundo 401 (credencial errada de verdade)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao')
        ? json(SESSAO_OK)
        : json({ erro: 'Sessão inválida.', codigo: 'nao_autenticado' }, 401),
    );
    const cliente = new ClienteChamados(CFG, impl);

    await expect(cliente.requisitar('/api/v1/chamados')).rejects.toBeInstanceOf(ErroApi);
    // Não entra em laço de reautenticação: 2 logins no máximo.
    expect(chamadas.filter((c) => c.url.endsWith('/api/v1/sessao'))).toHaveLength(2);
  });

  it('preserva o CÓDIGO do contrato no erro (corrigível pelo modelo)', async () => {
    const { impl } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao')
        ? json(SESSAO_OK)
        : json({ erro: 'Transição não permitida.', codigo: 'transicao_invalida' }, 409),
    );
    const cliente = new ClienteChamados(CFG, impl);

    const erro = await cliente.requisitar('/api/v1/chamados/1/status').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroApi);
    expect((erro as ErroApi).codigo).toBe('transicao_invalida');
    expect((erro as ErroApi).status).toBe(409);
  });

  it('nunca expõe a senha na mensagem de erro do login', async () => {
    const { impl } = fakeFetch(() =>
      json({ erro: 'E-mail ou senha inválidos.', codigo: 'credenciais_invalidas' }, 401),
    );
    const cliente = new ClienteChamados(CFG, impl);

    const erro = (await cliente.requisitar('/api/v1/chamados').catch((e: unknown) => e)) as ErroApi;
    expect(erro.message).not.toContain(CFG.senha);
    expect(erro.codigo).toBe('credenciais_invalidas');
  });

  it('envia o slug do tenant quando configurado (host que não resolve — dev)', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao') ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(
      { ...CFG, baseUrl: 'http://localhost:3000', tenantSlug: 'acme' },
      impl,
    );

    await cliente.requisitar('/api/v1/chamados');

    for (const c of chamadas) {
      expect((c.init?.headers as Record<string, string>)['x-tenant-slug']).toBe('acme');
    }
  });

  it('monta a query string ignorando parâmetros vazios', async () => {
    const { impl, chamadas } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao') ? json(SESSAO_OK) : json({ itens: [] }),
    );
    const cliente = new ClienteChamados(CFG, impl);

    await cliente.requisitar('/api/v1/chamados', {
      query: { status: 'novo,em_triagem', busca: undefined, cursor: '' },
    });

    const url = new URL(chamadas[1]!.url);
    expect(url.searchParams.get('status')).toBe('novo,em_triagem');
    expect(url.searchParams.has('busca')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('trata 204 (logout) sem tentar parsear JSON', async () => {
    const { impl } = fakeFetch((c) =>
      c.url.endsWith('/api/v1/sessao') && c.init?.method === 'POST'
        ? json(SESSAO_OK)
        : new Response(null, { status: 204 }),
    );
    const cliente = new ClienteChamados(CFG, impl);

    await expect(
      cliente.requisitar('/api/v1/sessao', { metodo: 'DELETE' }),
    ).resolves.toBeUndefined();
  });
});
