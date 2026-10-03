import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ROTAS_API, type ErroApiDto } from '../../comum/dto';
import type { ConfigForja } from '../config';
import type { BarramentoEventos } from '../eventos/barramento';
import { registrarRotas } from './rotas';
import type { FonteEventosHttp, ServicosHttp } from './rotas/tipos';
import { ehCaminhoApi, registrarSegurancaLocal } from './seguranca-local';
import { registrarTerminalWs, type GerenteParaWs } from './terminal-ws';

/**
 * Servidor HTTP da Forja (specs/forja/01 §3, §4.1): Fastify em `127.0.0.1`,
 * API REST + SSE, WebSocket só para o PTY e os estáticos da SPA (`web/dist`).
 *
 * Ordem de registro importa: cookie → **websocket** → segurança local (hook
 * `onRequest` que vale para TUDO, inclusive estáticos e 404) → WebSocket do
 * PTY → rotas da API → estáticos + fallback da SPA.
 *
 * POR QUE o plugin de websocket ANTES da segurança: o `onRequest` dele marca o
 * pedido de upgrade (`req.ws`) e o `onResponse` dele destrói o socket cru
 * quando a resposta não foi um 101. Registrado depois, um upgrade recusado
 * pelo hook global (Host/Origin/cookie) nunca era marcado — o socket ficava
 * pendurado e segurava o `app.close()` (achado da R2-PROC). Agora qualquer
 * upgrade recusado, em qualquer caminho, é fechado.
 *
 * `forceCloseConnections`: os streams SSE e os WebSockets são conexões que não
 * terminam sozinhas; no desligamento (01 §3.2) elas são cortadas em vez de
 * segurarem o processo.
 *
 * Sem logger do Fastify: o log padrão registraria a URL com `?t=<token>`
 * (05 §8.2 — nunca token em log).
 */

export interface DepsServidor {
  config: ConfigForja;
  barramento: BarramentoEventos;
  token: string;
  iniciadoEm: string;
  servicos: ServicosHttp;
  eventos: FonteEventosHttp;
  /** Gerente de PTY (null = Terminal indisponível: `node-pty` não carregou). */
  terminal: GerenteParaWs | null;
  log?: (mensagem: string, erro: unknown) => void;
}

/** Teto do corpo das requisições (05 §7.1 "Limites"). */
const LIMITE_CORPO_BYTES = 1024 * 1024;

export async function criarServidor(deps: DepsServidor): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: false,
    bodyLimit: LIMITE_CORPO_BYTES,
    forceCloseConnections: true,
  });
  const log =
    deps.log ?? ((mensagem: string, erro: unknown) => console.error(`[forja] ${mensagem}:`, erro));
  const seguranca = { porta: config.porta, modo: config.modo, token: deps.token };

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  registrarSegurancaLocal(app, seguranca);

  if (deps.terminal) {
    registrarTerminalWs(app, { sessoes: deps.terminal, seguranca });
  } else {
    // Resposta no `onRequest` (antes do handler que o plugin de websocket
    // embrulha): o upgrade recebe o 503 em vez de um 101 seguido de close.
    const indisponivel: ErroApiDto = {
      erro: 'nao_implementado',
      mensagem: 'Terminal indisponível nesta máquina (node-pty não carregou; veja o Diagnóstico)',
    };
    app.route({
      method: 'GET',
      url: ROTAS_API.terminal_ws.caminho,
      onRequest: async (_req, reply) => reply.code(503).send(indisponivel),
      handler: async (_req, reply) => reply.code(503).send(indisponivel),
    });
  }

  registrarRotas(app, {
    config,
    barramento: deps.barramento,
    iniciadoEm: deps.iniciadoEm,
    servicos: deps.servicos,
    eventos: deps.eventos,
    log,
  });

  const temSpa = existsSync(join(config.dirWebDist, 'index.html'));
  if (temSpa) {
    await app.register(fastifyStatic, {
      root: config.dirWebDist,
      wildcard: false,
      index: ['index.html'],
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (ehCaminhoApi(req.url)) {
      const corpo: ErroApiDto = { erro: 'nao_encontrado', mensagem: 'Rota inexistente' };
      return reply.code(404).send(corpo);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send();
    }
    if (!temSpa) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send(
          'SPA não buildada: rode `npm run build -w @chamados/forja` (ou use `npm run dev:forja`).',
        );
    }
    // Fallback da SPA: rotas do React Router (/fila, /execucoes/:id…) servem o index.
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });

  app.setErrorHandler((erro: FastifyError, req, reply) => {
    const status = erro.statusCode ?? 500;
    let corpo: ErroApiDto;
    if (erro.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      corpo = { erro: 'corpo_grande_demais', mensagem: 'Corpo da requisição grande demais' };
    } else if (status >= 400 && status < 500) {
      corpo = { erro: 'entrada_invalida', mensagem: erro.message };
    } else {
      // Nunca vaza stack ao navegador; o detalhe vai para o stderr do terminal.
      log(`erro em ${req.method} ${req.url.split('?')[0]}`, erro);
      corpo = { erro: 'erro_interno', mensagem: 'Erro interno da Forja (veja o terminal)' };
    }
    return reply.code(status >= 400 ? status : 500).send(corpo);
  });

  return app;
}
