import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControleTerminalServidor } from '../../comum/dto';
import type { ClienteTerminal, InfoSessaoTerminal } from '../terminal/sessoes';
import { registrarSegurancaLocal } from './seguranca-local';
import {
  interpretarControle,
  registrarTerminalWs,
  validarUpgradeTerminal,
  type GerenteParaWs,
} from './terminal-ws';

/**
 * WebSocket do PTY com Fastify REAL em porta efêmera (05 §7.2): o handshake
 * com Origin/Host/cookie errados nunca vira socket; o certo troca bytes e
 * controle. O gerente de sessões é falso (nenhum `claude`).
 */

// `ws` vem com o @fastify/websocket; sem @types/ws, tipamos só o que o teste usa.
interface ClienteWs {
  on(evento: 'open', fn: () => void): void;
  on(evento: 'message', fn: (dados: Buffer, binario: boolean) => void): void;
  on(
    evento: 'unexpected-response',
    fn: (req: { destroy(): void }, res: { statusCode: number }) => void,
  ): void;
  on(evento: 'error', fn: (erro: Error) => void): void;
  on(evento: 'close', fn: (codigo: number) => void): void;
  send(dados: string | Buffer, opcoes?: { binary?: boolean }): void;
  close(): void;
}
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, opcoes: { headers: Record<string, string> }) => ClienteWs;
};

const TOKEN = 'token-de-teste-com-tamanho-suficiente';

async function portaLivre(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

class GerenteFalso implements GerenteParaWs {
  entrada: string[] = [];
  tamanhos: [number, number][] = [];
  clientes: ClienteTerminal[] = [];
  obter(id: string): InfoSessaoTerminal | null {
    return id === 's1' ? ({ id } as InfoSessaoTerminal) : null;
  }
  anexar(_id: string, cliente: ClienteTerminal): () => void {
    this.clientes.push(cliente);
    cliente.enviarControle({ tipo: 'scrollback_inicio' });
    cliente.enviarBytes('historico');
    cliente.enviarControle({ tipo: 'scrollback_fim' });
    return () => {
      this.clientes = this.clientes.filter((c) => c !== cliente);
    };
  }
  escrever(_id: string, dados: string): void {
    this.entrada.push(dados);
  }
  redimensionar(_id: string, c: number, l: number): void {
    this.tamanhos.push([c, l]);
  }
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function subir(comHookGlobal: boolean) {
  const porta = await portaLivre();
  const gerente = new GerenteFalso();
  const seguranca = { porta, modo: 'producao' as const, token: TOKEN };
  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (comHookGlobal) registrarSegurancaLocal(app, seguranca);
  await app.register(fastifyWebsocket);
  registrarTerminalWs(app, { sessoes: gerente, seguranca });
  await app.listen({ host: '127.0.0.1', port: porta });
  return { porta, gerente };
}

function cabecalhos(porta: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: `http://127.0.0.1:${porta}`,
    Cookie: `forja_sessao=${TOKEN}`,
    ...extra,
  };
}

function handshake(url: string, headers: Record<string, string>): Promise<number | 'aberto'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('aberto');
    });
    // Com ouvinte de `unexpected-response`, abortar a requisição é nosso papel.
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      resolve(res.statusCode);
    });
    ws.on('error', () => {});
  });
}

describe('WS /api/terminal/:sessao (05 §7.2)', () => {
  for (const comHookGlobal of [true, false]) {
    const rotulo = comHookGlobal ? 'com o hook global' : 'só com a validação da rota';
    it(`recusa o handshake com Origin/Host/cookie errados (${rotulo})`, async () => {
      const { porta } = await subir(comHookGlobal);
      const url = `ws://127.0.0.1:${porta}/api/terminal/s1`;
      expect(await handshake(url, cabecalhos(porta, { Origin: 'http://evil.example' }))).toBe(403);
      expect(await handshake(url, cabecalhos(porta, { Origin: 'http://127.0.0.1:5173' }))).toBe(
        403,
      );
      expect(await handshake(url, { Cookie: `forja_sessao=${TOKEN}` })).toBe(403);
      expect(await handshake(url, cabecalhos(porta, { Host: `evil.example:${porta}` }))).toBe(403);
      expect(await handshake(url, cabecalhos(porta, { Cookie: 'forja_sessao=errado' }))).toBe(401);
      expect(await handshake(url, cabecalhos(porta, { Cookie: '' }))).toBe(401);
      expect(
        await handshake(`ws://127.0.0.1:${porta}/api/terminal/nao-existe`, cabecalhos(porta)),
      ).toBe(404);
      expect(await handshake(url, cabecalhos(porta))).toBe('aberto');
    });
  }

  it('GET sem upgrade não abre nada', async () => {
    const { porta } = await subir(false);
    const r = await app!.inject({
      method: 'GET',
      url: '/api/terminal/s1',
      headers: { host: `127.0.0.1:${porta}`, cookie: `forja_sessao=${TOKEN}` },
    });
    expect(r.statusCode).toBe(426);
  });

  it('bytes nos dois sentidos + controle JSON; texto inválido não vira entrada', async () => {
    const { porta, gerente } = await subir(true);
    const ws = new WebSocket(`ws://127.0.0.1:${porta}/api/terminal/s1`, {
      headers: cabecalhos(porta),
    });
    const recebidos: (string | ControleTerminalServidor)[] = [];
    ws.on('message', (dados, binario) => {
      recebidos.push(
        binario
          ? dados.toString('utf8')
          : (JSON.parse(dados.toString('utf8')) as ControleTerminalServidor),
      );
    });
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(Buffer.from('ls -la\r'), { binary: true });
    ws.send(JSON.stringify({ tipo: 'redimensionar', colunas: 132, linhas: 40 }));
    ws.send('{"tipo":"redimensionar","colunas":"x"}');
    ws.send('não é json');
    const limite = Date.now() + 2000;
    while ((gerente.entrada.length < 1 || gerente.tamanhos.length < 1) && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(gerente.entrada).toEqual(['ls -la\r']);
    expect(gerente.tamanhos).toEqual([[132, 40]]);
    gerente.clientes[0]!.enviarBytes('saída ao vivo');
    gerente.clientes[0]!.enviarControle({ tipo: 'encerrado', codigo: 0, sinal: null });
    while (recebidos.length < 5 && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(recebidos).toEqual([
      { tipo: 'scrollback_inicio' },
      'historico',
      { tipo: 'scrollback_fim' },
      'saída ao vivo',
      { tipo: 'encerrado', codigo: 0, sinal: null },
    ]);
    ws.close();
    while (gerente.clientes.length > 0 && Date.now() < limite + 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gerente.clientes).toHaveLength(0);
  });
});

describe('funções puras do WS', () => {
  const seg = { porta: 4317, modo: 'producao' as const, token: TOKEN };
  it('validarUpgradeTerminal: ordem Host → upgrade → Origin → cookie', () => {
    const ok = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', upgrade: 'websocket' };
    expect(validarUpgradeTerminal(ok, TOKEN, seg)).toEqual({ ok: true });
    expect(validarUpgradeTerminal({ ...ok, host: 'x:4317' }, TOKEN, seg)).toMatchObject({
      status: 403,
    });
    expect(validarUpgradeTerminal({ ...ok, upgrade: undefined }, TOKEN, seg)).toMatchObject({
      status: 426,
    });
    expect(validarUpgradeTerminal({ ...ok, origin: undefined }, TOKEN, seg)).toMatchObject({
      status: 403,
    });
    expect(validarUpgradeTerminal(ok, undefined, seg)).toMatchObject({ status: 401 });
    expect(
      validarUpgradeTerminal({ ...ok, origin: 'http://localhost:5173' }, TOKEN, {
        ...seg,
        modo: 'dev',
      }),
    ).toEqual({ ok: true });
  });

  it('interpretarControle aceita só redimensionar com inteiros positivos', () => {
    expect(interpretarControle('{"tipo":"redimensionar","colunas":80,"linhas":24}')).toEqual({
      tipo: 'redimensionar',
      colunas: 80,
      linhas: 24,
    });
    expect(interpretarControle('{"tipo":"redimensionar","colunas":0,"linhas":24}')).toBeNull();
    expect(interpretarControle('{"tipo":"redimensionar","colunas":1.5,"linhas":24}')).toBeNull();
    expect(interpretarControle('{"tipo":"executar","cmd":"rm"}')).toBeNull();
    expect(interpretarControle('ls')).toBeNull();
  });
});
