import {
  ROTAS_API,
  montarCaminho,
  type ControleTerminalCliente,
  type ControleTerminalServidor,
} from '@comum/dto';

/**
 * Cliente WebSocket do Terminal PTY (specs/forja/01 §8.1, §11; 06 §4.7):
 * `WS /api/terminal/:sessao` na mesma origem. O upgrade exige cookie, Host e
 * Origin (05 §7.2) — o navegador manda os três sozinho.
 *
 * Protocolo (lado servidor em `server/http/terminal-ws.ts`):
 * - teclas e bytes colados SOBEM como frame **BINÁRIO** (UTF-8). Nunca como
 *   texto: o servidor trata todo frame de texto como controle JSON e o ignora
 *   se não for um controle válido — tecla mandada como texto simplesmente some
 *   (e um paste de JSON não pode virar "redimensionar");
 * - controle SOBE como frame de **texto** JSON (`ControleTerminalCliente`);
 * - DESCE binário = saída do PTY; texto = `ControleTerminalServidor`
 *   (`scrollback_inicio`/`scrollback_fim` ao reanexar, `encerrado` na saída).
 *
 * `conectarTerminal` não conhece o xterm: recebe callbacks e devolve funções
 * de envio, para ser testável com um socket falso. É a ÚNICA implementação do
 * protocolo: o `<XtermPty>` (componentes/terminal/xterm.tsx) a usa.
 */

/** URL do WebSocket na mesma origem (`ws:` porque o app é http em loopback). */
export function urlTerminalWs(
  sessaoId: string,
  origem: { protocol: string; host: string },
): string {
  const proto = origem.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${origem.host}${montarCaminho(ROTAS_API.terminal_ws.caminho, { sessao: sessaoId })}`;
}

export function mensagemRedimensionar(colunas: number, linhas: number): string {
  const msg: ControleTerminalCliente = {
    tipo: 'redimensionar',
    colunas: Math.max(1, Math.floor(colunas)),
    linhas: Math.max(1, Math.floor(linhas)),
  };
  return JSON.stringify(msg);
}

/** Frame de texto do servidor → controle válido, ou `null` (ignorado). */
export function lerControleServidor(texto: string): ControleTerminalServidor | null {
  let dado: unknown;
  try {
    dado = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!dado || typeof dado !== 'object') return null;
  const tipo = (dado as { tipo?: unknown }).tipo;
  if (tipo === 'scrollback_inicio' || tipo === 'scrollback_fim') return { tipo };
  if (tipo === 'encerrado') {
    const d = dado as { codigo?: unknown; sinal?: unknown };
    return {
      tipo: 'encerrado',
      codigo: typeof d.codigo === 'number' ? d.codigo : null,
      sinal: typeof d.sinal === 'string' ? d.sinal : null,
    };
  }
  return null;
}

/** O que usamos do `WebSocket` do navegador (injetável nos testes). */
export interface SocketTerminalCliente {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((msg: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(dados: string | ArrayBufferView | ArrayBuffer): void;
  close(codigo?: number): void;
}

export type EstadoTerminal = 'conectando' | 'conectado' | 'encerrado' | 'desconectado';

export interface EventosTerminal {
  /** Saída do PTY (bytes crus; o xterm decodifica). */
  aoBytes(dados: Uint8Array): void;
  aoControle?(controle: ControleTerminalServidor): void;
  aoEstado?(
    estado: EstadoTerminal,
    detalhe?: { codigo: number | null; sinal: string | null; fechamento?: number },
  ): void;
}

export interface ConexaoTerminal {
  /** Teclas/paste: frame binário UTF-8. */
  enviarTeclas(texto: string): void;
  /** Bytes crus (o `onBinary` do xterm): frame binário. */
  enviarBytes(bytes: Uint8Array): void;
  /** Controle JSON (frame de texto). */
  redimensionar(colunas: number, linhas: number): void;
  fechar(): void;
}

const ABERTO = 1;

export function conectarTerminal(
  sessaoId: string,
  eventos: EventosTerminal,
  opcoes: {
    origem?: { protocol: string; host: string };
    criarSocket?: (url: string) => SocketTerminalCliente;
  } = {},
): ConexaoTerminal {
  const origem = opcoes.origem ?? window.location;
  const url = urlTerminalWs(sessaoId, origem);
  const socket = opcoes.criarSocket
    ? opcoes.criarSocket(url)
    : (new WebSocket(url) as unknown as SocketTerminalCliente);
  socket.binaryType = 'arraybuffer';
  const codificador = new TextEncoder();
  let encerrado = false;
  let fechadoPorNos = false;

  eventos.aoEstado?.('conectando');
  socket.onopen = () => eventos.aoEstado?.('conectado');
  socket.onmessage = (msg) => {
    const { data } = msg;
    if (typeof data === 'string') {
      const controle = lerControleServidor(data);
      if (!controle) return;
      if (controle.tipo === 'encerrado') {
        encerrado = true;
        eventos.aoEstado?.('encerrado', { codigo: controle.codigo, sinal: controle.sinal });
      }
      eventos.aoControle?.(controle);
      return;
    }
    if (data instanceof ArrayBuffer) eventos.aoBytes(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) {
      eventos.aoBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Só se o binaryType tiver sido trocado por fora; mantém a ordem pelo await.
      void data.arrayBuffer().then((b) => eventos.aoBytes(new Uint8Array(b)));
    }
  };
  socket.onclose = (ev) => {
    if (!encerrado && !fechadoPorNos) {
      eventos.aoEstado?.('desconectado', { codigo: null, sinal: null, fechamento: ev.code });
    }
  };
  socket.onerror = () => {};

  const aberto = () => socket.readyState === ABERTO;
  return {
    enviarTeclas(texto) {
      if (aberto() && texto.length > 0) socket.send(codificador.encode(texto));
    },
    enviarBytes(bytes) {
      if (aberto() && bytes.length > 0) socket.send(bytes);
    },
    redimensionar(colunas, linhas) {
      if (aberto()) socket.send(mensagemRedimensionar(colunas, linhas));
    },
    fechar() {
      fechadoPorNos = true;
      socket.onclose = null;
      socket.close();
    },
  };
}
