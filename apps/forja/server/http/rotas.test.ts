import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventoForja } from '../../comum/protocolo-eventos';
import type { ConfigForja } from '../config';
import { LIMITE_REPLAY, PersistenciaEventosSqlite } from '../db/persistencia-eventos';
import {
  montarAmbiente,
  type AmbienteOrquestrador,
} from '../dominio/apoio-orquestrador.test-apoio';
import { ServicosForja } from '../dominio/servicos';
import { BarramentoEventos } from '../eventos/barramento';
import { criarServidor } from './servidor';

/**
 * API local de ponta a ponta (specs/forja/01 §4.1, §8.1; 05 §7.1): Fastify REAL
 * com a fachada real sobre SQLite + git temporários (o ambiente dos testes do
 * orquestrador). Nenhum `claude`, nenhuma rede além de 127.0.0.1.
 */

const TOKEN = 'token-de-teste-com-tamanho-suficiente-1234';

interface ClienteWs {
  on(
    evento: 'unexpected-response',
    fn: (req: { destroy(): void }, res: { statusCode: number }) => void,
  ): void;
  on(evento: 'error', fn: (erro: Error) => void): void;
  on(evento: 'open', fn: () => void): void;
  terminate(): void;
}
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, opcoes: { headers: Record<string, string> }) => ClienteWs;
};

async function portaLivre(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

let amb: AmbienteOrquestrador | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await amb?.limpar();
  amb = null;
});

async function subir(opcoes: { barramento?: BarramentoEventos } = {}) {
  amb = await montarAmbiente();
  const porta = await portaLivre();
  const config: ConfigForja = {
    modo: 'producao',
    host: '127.0.0.1',
    porta,
    dirDados: amb.repo.dados,
    dirWebDist: '/nao/existe',
    versao: '9.9.9',
  };
  const servicos = new ServicosForja({
    orq: amb.orq,
    versao: '9.9.9',
    modo: 'producao',
    iniciadoEm: '2026-10-02T12:00:00.000Z',
  });
  const persistencia = new PersistenciaEventosSqlite(amb.banco);
  const barramento = opcoes.barramento ?? amb.barramento;
  const erros: unknown[] = [];
  app = await criarServidor({
    config,
    barramento,
    token: TOKEN,
    iniciadoEm: '2026-10-02T12:00:00.000Z',
    servicos,
    terminal: null,
    log: (_m, e) => erros.push(e),
    eventos: {
      desde: async (seq, filtro) => {
        const l = await persistencia.desde(seq, { predicado: filtro, limite: LIMITE_REPLAY + 1 });
        return l.length > LIMITE_REPLAY ? null : l;
      },
      execucaoExiste: async (id) => (await amb!.banco.ler((r) => r.execucoes.obter(id))) !== null,
    },
  });
  await app.listen({ host: '127.0.0.1', port: porta });
  const base = `http://127.0.0.1:${porta}`;
  const cabecalhos = {
    host: `127.0.0.1:${porta}`,
    cookie: `forja_sessao=${TOKEN}`,
    origin: base,
  };
  return { app, porta, base, cabecalhos, erros };
}

/** Lê o stream SSE até `ate` aparecer (ou o prazo vencer). */
async function lerSse(resposta: Response, ate: (texto: string) => boolean): Promise<string> {
  const leitor = resposta.body!.getReader();
  let texto = '';
  const limite = Date.now() + 3000;
  while (Date.now() < limite && !ate(texto)) {
    const r = await Promise.race([
      leitor.read(),
      new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(1, limite - Date.now()))),
    ]);
    if (!r || r.done) break;
    texto += new TextDecoder().decode(r.value);
  }
  await leitor.cancel().catch(() => {});
  return texto;
}

function eventosDoTexto(texto: string): EventoForja[] {
  return texto
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as EventoForja);
}

describe('rotas da API local ligadas à fachada', () => {
  it('serve shell e projetos com cookie; 401 sem', async () => {
    const { app, cabecalhos } = await subir();
    const shell = await app.inject({ method: 'GET', url: '/api/shell', headers: cabecalhos });
    expect(shell.statusCode).toBe(200);
    expect(shell.json()).toMatchObject({ modo: 'producao' });

    const semCookie = await app.inject({
      method: 'GET',
      url: '/api/projetos',
      headers: { host: cabecalhos.host },
    });
    expect(semCookie.statusCode).toBe(401);

    const projetos = await app.inject({ method: 'GET', url: '/api/projetos', headers: cabecalhos });
    expect(projetos.statusCode).toBe(200);
    expect(projetos.json().projetos.map((p: { nome: string }) => p.nome)).toEqual(['ERP']);
  });

  it('traduz erro do domínio em ErroApiDto (404, 400) e nunca vaza 500 cru', async () => {
    const { app, cabecalhos, erros } = await subir();
    const r404 = await app.inject({
      method: 'GET',
      url: '/api/execucoes/nao-existe',
      headers: cabecalhos,
    });
    expect(r404.statusCode).toBe(404);
    expect(r404.json()).toMatchObject({ erro: 'nao_encontrado' });

    const lista = await app.inject({
      method: 'POST',
      url: '/api/fila/sincronizar',
      headers: { ...cabecalhos, 'content-type': 'application/json' },
      payload: '[1,2]',
    });
    expect(lista.statusCode).toBe(400);
    expect(lista.json()).toMatchObject({ erro: 'entrada_invalida' });

    const numero = await app.inject({
      method: 'GET',
      url: '/api/execucoes/x/feed?limite=abc',
      headers: cabecalhos,
    });
    expect(numero.statusCode).toBe(400);

    const diag = await app.inject({ method: 'GET', url: '/api/diagnostico', headers: cabecalhos });
    expect(diag.statusCode).toBe(501);
    expect(diag.json()).toMatchObject({ erro: 'nao_implementado' });
    expect(erros).toEqual([]);
  });

  it('normaliza a query: listas e booleanos chegam tipados à fachada', async () => {
    const { app, cabecalhos } = await subir();
    const r = await app.inject({
      method: 'GET',
      url: '/api/fila?status=novo&status=em_atendimento&so_implementaveis=true',
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ itens: [] });
  });

  it('POST de criação responde 201 e exige Origin', async () => {
    const { app, cabecalhos } = await subir();
    const corpo = {
      nome: 'outra',
      url_base: 'https://outra.acme.com',
      tenant_slug: null,
      ambiente: 'dev',
      email: 'forja@acme.com',
      local_senha: 'keyring',
    };
    const semOrigem = await app.inject({
      method: 'POST',
      url: '/api/conexoes',
      headers: { host: cabecalhos.host, cookie: cabecalhos.cookie },
      payload: corpo,
    });
    expect(semOrigem.statusCode).toBe(403);
    const criada = await app.inject({
      method: 'POST',
      url: '/api/conexoes',
      headers: cabecalhos,
      payload: corpo,
    });
    expect(criada.statusCode).toBe(201);
    expect(criada.json().id).toEqual(expect.any(String));
  });

  it('rota binária: artefato inexistente → 404 tipado', async () => {
    const { app, cabecalhos } = await subir();
    const r = await app.inject({
      method: 'GET',
      url: '/api/execucoes/e1/evidencias/a1/imagem',
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ erro: 'nao_encontrado' });
  });

  it('terminal sem node-pty: rota do WS responde 503 em vez de pendurar', async () => {
    const { app, cabecalhos } = await subir();
    const r = await app.inject({ method: 'GET', url: '/api/terminal/s1', headers: cabecalhos });
    expect(r.statusCode).toBe(503);
  });
});

describe('SSE sobre o SQLite (01 §8.1, A6)', () => {
  it('entrega ao vivo o que o núcleo publica', async () => {
    const { base, cabecalhos } = await subir();
    const resp = await fetch(`${base}/api/eventos`, { headers: cabecalhos });
    expect(resp.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const lendo = lerSse(resp, (t) => t.includes('"cli.alerta"'));
    await new Promise((r) => setTimeout(r, 50));
    await amb!.orq.n.publicar({
      execucao_id: null,
      etapa_id: null,
      tipo: 'cli.alerta',
      nivel: 'aviso',
      resumo: 'teste ao vivo',
      dados: { codigo: 'x', bloqueante: false },
    });
    const evs = eventosDoTexto(await lendo);
    expect(evs.map((e) => e.resumo)).toContain('teste ao vivo');
  });

  it('reconexão com ultimo_seq reproduz do BANCO (anel vazio após reboot), sem duplicata', async () => {
    // Barramento novo = processo reiniciado: anel vazio, `seq` continua o do banco.
    // O ambiente do teste: grava 3 eventos SÓ no banco e sobe com barramento vazio.
    amb = await montarAmbiente();
    for (const resumo of ['a', 'b', 'c']) {
      await amb.banco.transacao((r) =>
        r.eventos.acrescentar({
          execucao_id: null,
          etapa_id: null,
          tipo: 'cli.alerta',
          nivel: 'info',
          resumo,
          dados: { codigo: resumo, bloqueante: false },
        }),
      );
    }
    const ultimo = await new PersistenciaEventosSqlite(amb.banco).ultimoSeq();
    const vazio = new BarramentoEventos({ seqInicial: ultimo });
    const ambDoTeste = amb;
    const porta = await portaLivre();
    const persistencia = new PersistenciaEventosSqlite(ambDoTeste.banco);
    app = await criarServidor({
      config: {
        modo: 'producao',
        host: '127.0.0.1',
        porta,
        dirDados: ambDoTeste.repo.dados,
        dirWebDist: '/nao/existe',
        versao: '9.9.9',
      },
      barramento: vazio,
      token: TOKEN,
      iniciadoEm: '2026-10-02T12:00:00.000Z',
      servicos: new ServicosForja({
        orq: ambDoTeste.orq,
        versao: '9.9.9',
        modo: 'producao',
        iniciadoEm: '2026-10-02T12:00:00.000Z',
      }),
      terminal: null,
      eventos: {
        desde: (seq, filtro) => persistencia.desde(seq, { predicado: filtro }),
        execucaoExiste: async () => false,
      },
    });
    await app.listen({ host: '127.0.0.1', port: porta });
    const base = `http://127.0.0.1:${porta}`;
    const resp = await fetch(`${base}/api/eventos?ultimo_seq=${ultimo - 2}`, {
      headers: { host: `127.0.0.1:${porta}`, cookie: `forja_sessao=${TOKEN}` },
    });
    const evs = eventosDoTexto(await lerSse(resp, (t) => (t.match(/data: /g) ?? []).length >= 2));
    expect(evs.map((e) => e.resumo)).toEqual(['b', 'c']);
    expect(evs.map((e) => e.seq)).toEqual([ultimo - 1, ultimo]);
  });

  it('canal de execução inexistente → 404', async () => {
    const { base, cabecalhos } = await subir();
    const r = await fetch(`${base}/api/execucoes/nao-existe/eventos`, { headers: cabecalhos });
    expect(r.status).toBe(404);
  });
});

describe('upgrade de WebSocket recusado (vazamento de socket da R2)', () => {
  it('Origin forjado em QUALQUER caminho → 403 e o app.close() não pendura', async () => {
    const { porta, cabecalhos } = await subir();
    const status = await new Promise<number>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${porta}/api/shell`, {
        headers: { cookie: cabecalhos.cookie, origin: 'http://malicioso.example' },
      });
      ws.on('unexpected-response', (req, res) => {
        req.destroy();
        ok(res.statusCode);
      });
      ws.on('error', () => ok(0));
      ws.on('open', () => {
        ws.terminate();
        ok(101);
      });
    });
    expect(status).toBe(403);
    const inicio = Date.now();
    await app!.close();
    app = null;
    expect(Date.now() - inicio).toBeLessThan(2000);
  });
});
