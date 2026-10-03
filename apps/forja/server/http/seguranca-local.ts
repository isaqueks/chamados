import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ErroApiDto } from '../../comum/dto';
import type { ModoForja } from '../../comum/estados';
import { PORTA_VITE_DEV } from '../config';

/**
 * Segurança do servidor local (specs/forja/05 §7.1). A Forja executa comandos
 * como o usuário (o WebSocket do PTY é, literalmente, um shell): qualquer página
 * aberta no navegador que conseguisse falar com `127.0.0.1:4317` teria RCE.
 * Por isso, em TODA requisição:
 *
 * 1. **Host** ∈ {`127.0.0.1:<porta>`, `localhost:<porta>`} — anti-DNS-rebinding
 *    (um domínio do atacante resolvendo para 127.0.0.1 chega com outro Host).
 * 2. **Token por boot** (256 bits, só em memória) trocado por cookie
 *    `HttpOnly; SameSite=Strict; Path=/` na abertura `/?t=<token>`; a URL é
 *    limpa por redirect. Todo `/api/*` exige o cookie (exceto `/api/saude`).
 * 3. **Origin** igual à origem do app em POST/PUT/PATCH/DELETE e no upgrade do
 *    WebSocket (anti-CSRF/CSWSH); ausente ou diferente → 403.
 * 4. Nenhum cabeçalho CORS; CSP restritiva; `Cache-Control: no-store` na API.
 *
 * Limite declarado (05 §7.3): isto protege contra OUTRAS ORIGENS WEB, não
 * contra código local do mesmo UID (que pode ler o cookie do perfil do
 * navegador). O token nunca vai para disco nem para log.
 *
 * As funções puras abaixo são testadas em `seguranca-local.test.ts`; o hook
 * `registrarSegurancaLocal` só as compõe.
 */

export const NOME_COOKIE = 'forja_sessao';

/** Caminhos de `/api` que não exigem cookie (continuam exigindo Host válido). */
const API_PUBLICA: ReadonlySet<string> = new Set(['/api/saude']);

export interface OpcoesSeguranca {
  porta: number;
  modo: ModoForja;
  token: string;
}

/** 32 bytes aleatórios em base64url (≥ 256 bits, 05 §7.1). */
export function gerarTokenBoot(): string {
  return randomBytes(32).toString('base64url');
}

/** Comparação em tempo constante (o tamanho diferente já é falso). */
export function tokensIguais(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Anti-DNS-rebinding: só `127.0.0.1:<porta>` ou `localhost:<porta>`. */
export function hostPermitido(host: string | undefined, porta: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${porta}` || h === `localhost:${porta}`;
}

/** Origens aceitas: a do app e, só em dev, a do Vite (01 §12). */
export function origensPermitidas(porta: number, modo: ModoForja): string[] {
  const portas = modo === 'dev' ? [porta, PORTA_VITE_DEV] : [porta];
  return portas.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
}

export function origemPermitida(
  origin: string | undefined,
  porta: number,
  modo: ModoForja,
): boolean {
  if (!origin) return false;
  return origensPermitidas(porta, modo).includes(origin.trim().toLowerCase());
}

/** Métodos que mudam estado exigem `Origin`; o upgrade de WebSocket também. */
export function exigeOrigem(metodo: string, ehUpgradeWebSocket: boolean): boolean {
  if (ehUpgradeWebSocket) return true;
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(metodo.toUpperCase());
}

/**
 * Caminho sem query e com percent-encoding decodificado — o MESMO que o
 * roteador (find-my-way) usa para casar a rota. Comparar prefixo na URL crua
 * deixava `/%61pi/...` (= `/api/...` depois de roteado) passar sem cookie.
 * Encoding inválido devolve `null` (quem chama trata como "API": fail-closed).
 */
export function caminhoDecodificado(url: string): string | null {
  const cru = url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(cru);
  } catch {
    return null;
  }
}

function caminhoEhApi(caminho: string): boolean {
  return caminho === '/api' || caminho.startsWith('/api/');
}

export function ehCaminhoApi(url: string): boolean {
  const caminho = caminhoDecodificado(url);
  return caminho === null || caminhoEhApi(caminho);
}

/**
 * Exige cookie se o caminho (decodificado) OU a rota já casada pelo Fastify
 * (`req.routeOptions.url`, ex.: `/api/execucoes/:id`) for da API. A rota
 * roteada é a fonte autoritativa: qualquer grafia que chegue a um handler de
 * `/api` passa pela checagem.
 */
export function apiExigeSessao(url: string, rotaCasada?: string): boolean {
  const caminho = caminhoDecodificado(url);
  if (caminho === null) return true;
  const exige = (c: string): boolean => caminhoEhApi(c) && !API_PUBLICA.has(c);
  return exige(caminho) || (rotaCasada !== undefined && exige(rotaCasada));
}

/**
 * Remove o parâmetro `t` da URL (para o redirect que "limpa" o token da barra
 * de endereço e do histórico). `/api/sessao` volta para a raiz da SPA.
 */
export function urlSemToken(url: string): string {
  const [caminho = '/', query = ''] = url.split('?', 2);
  const qs = new URLSearchParams(query);
  qs.delete('t');
  const destino = caminho === '/api/sessao' ? '/' : caminho;
  const resto = qs.toString();
  return resto ? `${destino}?${resto}` : destino;
}

/** CSP de 05 §7.1 (+ `style-src 'unsafe-inline'` e `img-src data: blob:`, ver nota). */
export function politicaCsp(porta: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Desvio consciente: sonner/base-ui injetam <style> em runtime; estilo não executa script.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ws://127.0.0.1:${porta} ws://localhost:${porta}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function cabecalhosSeguranca(porta: number, api: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'content-security-policy': politicaCsp(porta),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (api) h['cache-control'] = 'no-store';
  return h;
}

/** Cookie da sessão de UI. Sem `Secure`: é http em loopback (05 §7.1). */
export function opcoesCookie(): {
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
  secure: false;
} {
  return { httpOnly: true, sameSite: 'strict', path: '/', secure: false };
}

function negar(reply: FastifyReply, status: 401 | 403, corpo: ErroApiDto): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send(corpo);
}

/**
 * Registra o hook `onRequest` (Host → token na URL → cookie → Origin) e o
 * `onSend` dos cabeçalhos. Precisa vir ANTES de qualquer rota e do estático.
 */
export function registrarSegurancaLocal(app: FastifyInstance, opcoes: OpcoesSeguranca): void {
  const { porta, modo, token } = opcoes;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hostPermitido(req.headers.host, porta)) {
      return negar(reply, 403, { erro: 'host_invalido', mensagem: 'Host não permitido' });
    }

    // Abertura pelo link impresso no terminal: `/?t=<token>` (ou `/api/sessao?t=` no dev).
    const consulta = req.query as Record<string, unknown> | undefined;
    const t = typeof consulta?.t === 'string' ? consulta.t : undefined;
    if (req.method === 'GET' && t !== undefined) {
      if (!tokensIguais(t, token)) {
        return negar(reply, 401, {
          erro: 'nao_autenticado',
          mensagem: 'Link expirado: reabra pelo endereço impresso no terminal onde a Forja subiu',
        });
      }
      reply.setCookie(NOME_COOKIE, token, opcoesCookie());
      return reply.header('cache-control', 'no-store').redirect(urlSemToken(req.url), 303);
    }

    const upgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (exigeOrigem(req.method, upgrade) && !origemPermitida(req.headers.origin, porta, modo)) {
      return negar(reply, 403, { erro: 'origem_invalida', mensagem: 'Origem não permitida' });
    }

    if (
      apiExigeSessao(req.url, req.routeOptions.url) &&
      !tokensIguais(req.cookies[NOME_COOKIE], token)
    ) {
      return negar(reply, 401, {
        erro: 'nao_autenticado',
        mensagem: 'Sessão expirada: reabra pelo link impresso no terminal onde a Forja subiu',
      });
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [nome, valor] of Object.entries(cabecalhosSeguranca(porta, ehCaminhoApi(req.url)))) {
      reply.header(nome, valor);
    }
    return payload;
  });
}
