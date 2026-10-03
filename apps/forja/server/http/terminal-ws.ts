import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/websocket';
import {
  ROTAS_API,
  type ControleTerminalCliente,
  type ControleTerminalServidor,
  type ErroApiDto,
} from '../../comum/dto';
import type { ClienteTerminal, GerenteSessoesTerminal } from '../terminal/sessoes';
import {
  hostPermitido,
  NOME_COOKIE,
  origemPermitida,
  tokensIguais,
  type OpcoesSeguranca,
} from './seguranca-local';

/**
 * WebSocket do PTY `WS /api/terminal/:sessao` (specs/forja/01 §8.1, §11;
 * 05 §7.2). Este socket É execução de comandos como o usuário: exposto, é RCE.
 *
 * POR QUE validar de novo aqui se o hook global de `seguranca-local` já valida:
 * defesa em profundidade num único ponto que não pode falhar — se um dia a
 * ordem de registro mudar (ou a rota for montada num app de teste sem o hook),
 * o upgrade continua exigindo Host ∈ loopback:porta, `Origin` da própria app
 * (anti-CSWSH) e o cookie de sessão. Tudo antes do 101: o handshake recusado
 * nunca vira socket. As regras são as MESMAS funções de `seguranca-local.ts`.
 *
 * Protocolo (01 §8.1; cliente em `web/src/lib/terminal.ts`):
 * - cliente → servidor: frame BINÁRIO = bytes digitados (UTF-8); frame de
 *   TEXTO = controle JSON (`{tipo:'redimensionar', colunas, linhas}`). Texto que
 *   não é controle válido é ignorado — nunca vira entrada do PTY (um paste de
 *   JSON não pode redimensionar nem ser confundido com controle).
 * - servidor → cliente: binário = saída do PTY; texto = `ControleTerminalServidor`
 *   (`scrollback_inicio`/`scrollback_fim` no anexar, `encerrado` na saída).
 * - Cliente lento (bufferedAmount acima do teto) é desconectado com 4008; ao
 *   reconectar recebe o scrollback. O PTY nunca espera o navegador.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_BUFFER_CLIENTE_BYTES = 8 * 1024 * 1024;
/** Códigos de fechamento próprios (faixa 4000–4999 é da aplicação). */
export const FECHAMENTO_CLIENTE_LENTO = 4008;
export const FECHAMENTO_FRAME_GRANDE = 1009;

const ABERTO = 1;

/** O que usamos do `ws.WebSocket` (os tipos do `ws` não estão instalados). */
export interface SocketTerminal {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(dados: string | Buffer, opcoes?: { binary?: boolean }): void;
  close(codigo?: number, motivo?: string): void;
  on(evento: 'message', fn: (dados: unknown, binario: boolean) => void): unknown;
  on(evento: 'close', fn: () => void): unknown;
  on(evento: 'error', fn: (erro: Error) => void): unknown;
}

export type GerenteParaWs = Pick<
  GerenteSessoesTerminal,
  'obter' | 'anexar' | 'escrever' | 'redimensionar'
>;

export interface DepsTerminalWs {
  sessoes: GerenteParaWs;
  seguranca: OpcoesSeguranca;
  maxFrameBytes?: number;
  maxBufferClienteBytes?: number;
}

export type ResultadoValidacaoUpgrade =
  { ok: true } | { ok: false; status: 401 | 403 | 426; corpo: ErroApiDto };

/** Regras do upgrade (05 §7.1/§7.2), puras para teste. */
export function validarUpgradeTerminal(
  cabecalhos: { host?: string; origin?: string; upgrade?: string },
  cookie: string | undefined,
  seguranca: OpcoesSeguranca,
): ResultadoValidacaoUpgrade {
  if (!hostPermitido(cabecalhos.host, seguranca.porta)) {
    return {
      ok: false,
      status: 403,
      corpo: { erro: 'host_invalido', mensagem: 'Host não permitido' },
    };
  }
  if ((cabecalhos.upgrade ?? '').toLowerCase() !== 'websocket') {
    return {
      ok: false,
      status: 426,
      corpo: { erro: 'entrada_invalida', mensagem: 'Esta rota só aceita WebSocket' },
    };
  }
  if (!origemPermitida(cabecalhos.origin, seguranca.porta, seguranca.modo)) {
    return {
      ok: false,
      status: 403,
      corpo: { erro: 'origem_invalida', mensagem: 'Origem não permitida' },
    };
  }
  if (!tokensIguais(cookie, seguranca.token)) {
    return {
      ok: false,
      status: 401,
      corpo: { erro: 'nao_autenticado', mensagem: 'Sessão expirada: reabra pelo link do terminal' },
    };
  }
  return { ok: true };
}

/** Frame de texto → controle válido, ou null (ignorado). */
export function interpretarControle(texto: string): ControleTerminalCliente | null {
  if (texto.length > 1024) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(texto);
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.tipo !== 'redimensionar') return null;
  const { colunas, linhas } = m;
  if (typeof colunas !== 'number' || typeof linhas !== 'number') return null;
  if (!Number.isInteger(colunas) || !Number.isInteger(linhas) || colunas < 1 || linhas < 1) {
    return null;
  }
  return { tipo: 'redimensionar', colunas, linhas };
}

function paraBuffer(dados: unknown): Buffer | null {
  if (Buffer.isBuffer(dados)) return dados;
  if (dados instanceof ArrayBuffer) return Buffer.from(dados);
  if (Array.isArray(dados) && dados.every((d) => Buffer.isBuffer(d))) {
    return Buffer.concat(dados as Buffer[]);
  }
  return null;
}

/**
 * Registra a rota do WebSocket. Requer `@fastify/cookie` e `@fastify/websocket`
 * já registrados. A R3 liga isto em `servidor.ts` NO LUGAR do stub
 * `terminal_ws` de `rotas/terminal.ts` (mesmo método + caminho).
 */
export function registrarTerminalWs(app: FastifyInstance, deps: DepsTerminalWs): void {
  const maxFrame = deps.maxFrameBytes ?? MAX_FRAME_BYTES;
  const maxBuffer = deps.maxBufferClienteBytes ?? MAX_BUFFER_CLIENTE_BYTES;

  const verificar = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    const r = validarUpgradeTerminal(
      { host: req.headers.host, origin: req.headers.origin, upgrade: req.headers.upgrade },
      cookies?.[NOME_COOKIE],
      deps.seguranca,
    );
    if (!r.ok) return reply.code(r.status).header('cache-control', 'no-store').send(r.corpo);
    const { sessao } = req.params as { sessao: string };
    if (!deps.sessoes.obter(sessao)) {
      const corpo: ErroApiDto = {
        erro: 'nao_encontrado',
        mensagem: 'Sessão de terminal inexistente',
      };
      return reply.code(404).send(corpo);
    }
    return undefined;
  };

  app.route({
    method: 'GET',
    url: ROTAS_API.terminal_ws.caminho,
    onRequest: verificar,
    // Handshake recusado: o socket do upgrade é nosso e precisa morrer. Se a
    // recusa veio do hook GLOBAL (registrado antes do @fastify/websocket), o
    // `onRequest` do plugin não rodou e o `onResponse` dele não destrói o
    // socket — ficaria pendurado (e seguraria o `app.close()`).
    onResponse: async (req) => {
      if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') req.raw.socket?.destroy();
    },
    // Sem upgrade o `verificar` já respondeu 426; isto só cobre o tipo da rota.
    handler: async (_req, reply) => {
      const corpo: ErroApiDto = { erro: 'entrada_invalida', mensagem: 'Use WebSocket' };
      return reply.code(426).send(corpo);
    },
    wsHandler: (socketBruto, req) => {
      const socket = socketBruto as unknown as SocketTerminal;
      const { sessao } = req.params as { sessao: string };

      const enviar = (dados: string | Buffer, binario: boolean): void => {
        if (socket.readyState !== ABERTO) return;
        if (socket.bufferedAmount > maxBuffer) {
          socket.close(FECHAMENTO_CLIENTE_LENTO, 'cliente_lento');
          return;
        }
        socket.send(dados, { binary: binario });
      };
      const cliente: ClienteTerminal = {
        enviarBytes: (dados) => enviar(Buffer.from(dados, 'utf8'), true),
        enviarControle: (msg: ControleTerminalServidor) => enviar(JSON.stringify(msg), false),
      };

      let desanexar: () => void = () => {};
      try {
        desanexar = deps.sessoes.anexar(sessao, cliente);
      } catch {
        socket.close(4404, 'sessao_inexistente');
        return;
      }

      socket.on('message', (dados, binario) => {
        const buf = paraBuffer(dados);
        if (!buf) return;
        if (buf.length > maxFrame) {
          socket.close(FECHAMENTO_FRAME_GRANDE, 'frame_grande');
          return;
        }
        if (binario) {
          deps.sessoes.escrever(sessao, buf.toString('utf8'));
          return;
        }
        const controle = interpretarControle(buf.toString('utf8'));
        if (controle) deps.sessoes.redimensionar(sessao, controle.colunas, controle.linhas);
      });
      socket.on('close', () => desanexar());
      socket.on('error', () => desanexar());
    },
  });
}
