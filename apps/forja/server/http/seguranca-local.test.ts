import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  apiExigeSessao,
  NOME_COOKIE,
  registrarSegurancaLocal,
  cabecalhosSeguranca,
  exigeOrigem,
  gerarTokenBoot,
  hostPermitido,
  origemPermitida,
  politicaCsp,
  tokensIguais,
  urlSemToken,
} from './seguranca-local';

describe('segurança do servidor local (05 §7.1)', () => {
  it('token de boot tem ≥ 256 bits e muda a cada geração', () => {
    const a = gerarTokenBoot();
    const b = gerarTokenBoot();
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it('compara tokens sem aceitar ausente, diferente ou de outro tamanho', () => {
    const t = gerarTokenBoot();
    expect(tokensIguais(t, t)).toBe(true);
    expect(tokensIguais(undefined, t)).toBe(false);
    expect(tokensIguais(t.slice(1), t)).toBe(false);
    expect(tokensIguais(gerarTokenBoot(), t)).toBe(false);
  });

  it('Host: só 127.0.0.1/localhost na porta do app (anti-DNS-rebinding)', () => {
    expect(hostPermitido('127.0.0.1:4317', 4317)).toBe(true);
    expect(hostPermitido('localhost:4317', 4317)).toBe(true);
    expect(hostPermitido('LOCALHOST:4317', 4317)).toBe(true);
    expect(hostPermitido('evil.com', 4317)).toBe(false);
    expect(hostPermitido('evil.com:4317', 4317)).toBe(false);
    expect(hostPermitido('127.0.0.1', 4317)).toBe(false);
    expect(hostPermitido('127.0.0.1:5173', 4317)).toBe(false);
    expect(hostPermitido('0.0.0.0:4317', 4317)).toBe(false);
    expect(hostPermitido(undefined, 4317)).toBe(false);
  });

  it('Origin: a do app; a do Vite (5173) só em dev', () => {
    expect(origemPermitida('http://127.0.0.1:4317', 4317, 'producao')).toBe(true);
    expect(origemPermitida('http://localhost:4317', 4317, 'producao')).toBe(true);
    expect(origemPermitida('http://127.0.0.1:5173', 4317, 'producao')).toBe(false);
    expect(origemPermitida('http://127.0.0.1:5173', 4317, 'dev')).toBe(true);
    expect(origemPermitida('https://127.0.0.1:4317', 4317, 'producao')).toBe(false);
    expect(origemPermitida('http://evil.com', 4317, 'dev')).toBe(false);
    expect(origemPermitida('null', 4317, 'dev')).toBe(false);
    expect(origemPermitida(undefined, 4317, 'dev')).toBe(false);
  });

  it('Origin é exigido em métodos que mudam estado e no upgrade de WebSocket', () => {
    expect(exigeOrigem('POST', false)).toBe(true);
    expect(exigeOrigem('put', false)).toBe(true);
    expect(exigeOrigem('DELETE', false)).toBe(true);
    expect(exigeOrigem('GET', false)).toBe(false);
    expect(exigeOrigem('GET', true)).toBe(true);
  });

  it('toda a API exige sessão, exceto /api/saude; estáticos não', () => {
    expect(apiExigeSessao('/api/fila')).toBe(true);
    expect(apiExigeSessao('/api/eventos?x=1')).toBe(true);
    expect(apiExigeSessao('/api/saude')).toBe(false);
    expect(apiExigeSessao('/api/saude?x=1')).toBe(false);
    expect(apiExigeSessao('/')).toBe(false);
    expect(apiExigeSessao('/assets/index.js')).toBe(false);
    expect(apiExigeSessao('/apiario')).toBe(false);
  });

  it('percent-encoding não pula a sessão: decide pelo caminho decodificado e pela rota casada', () => {
    expect(apiExigeSessao('/%61pi/execucoes/1')).toBe(true);
    expect(apiExigeSessao('/%2561pi/x')).toBe(false); // decodifica 1x, como o roteador
    expect(apiExigeSessao('/%E0%A4%A/x')).toBe(true); // encoding inválido → fail-closed
    expect(apiExigeSessao('/qualquer', '/api/execucoes/:id')).toBe(true);
    expect(apiExigeSessao('/api/saude', '/api/saude')).toBe(false);
  });

  it('hook real: /%61pi/... casa a rota da API e recebe 401 sem cookie (GET e POST)', async () => {
    const token = gerarTokenBoot();
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registrarSegurancaLocal(app, { porta: 4317, modo: 'producao', token });
    app.get('/api/execucoes/:id', async () => ({ dados: 'segredo' }));
    app.post('/api/execucoes/:id/aprovar', async () => ({ ok: true }));
    app.get('/api/saude', async () => ({ ok: true }));
    const host = { host: '127.0.0.1:4317' };
    const origem = { ...host, origin: 'http://127.0.0.1:4317' };
    try {
      for (const url of ['/api/execucoes/1', '/%61pi/execucoes/1', '/%61%70%69/execucoes/1']) {
        const r = await app.inject({ method: 'GET', url, headers: host });
        expect(r.statusCode, url).toBe(401);
      }
      const post = await app.inject({
        method: 'POST',
        url: '/%61pi/execucoes/1/aprovar',
        headers: origem,
      });
      expect(post.statusCode).toBe(401);
      const comCookie = await app.inject({
        method: 'GET',
        url: '/%61pi/execucoes/1',
        headers: host,
        cookies: { [NOME_COOKIE]: token },
      });
      expect(comCookie.statusCode).toBe(200);
      const saude = await app.inject({ method: 'GET', url: '/api/saude', headers: host });
      expect(saude.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('o redirect remove só o token da URL; /api/sessao volta para a raiz', () => {
    expect(urlSemToken('/?t=abc')).toBe('/');
    expect(urlSemToken('/fila?t=abc&projeto=1')).toBe('/fila?projeto=1');
    expect(urlSemToken('/api/sessao?t=abc')).toBe('/');
  });

  it('CSP fecha script inline, frames, object e base-uri; API sem cache', () => {
    const csp = politicaCsp(4317);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain('ws://127.0.0.1:4317');
    expect(cabecalhosSeguranca(4317, true)['cache-control']).toBe('no-store');
    expect(cabecalhosSeguranca(4317, false)['cache-control']).toBeUndefined();
    expect(Object.keys(cabecalhosSeguranca(4317, true))).not.toContain(
      'access-control-allow-origin',
    );
  });
});
