import { describe, expect, it } from 'vitest';
import {
  conectarTerminal,
  lerControleServidor,
  type EstadoTerminal,
  type SocketTerminalCliente,
} from './terminal';

/** Socket falso: registra o que sobe e deixa o teste empurrar o que desce. */
class SocketFalso implements SocketTerminalCliente {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  enviados: (string | Uint8Array)[] = [];
  fechou = false;
  constructor(readonly url: string) {}
  send(dados: string | ArrayBufferView | ArrayBuffer): void {
    this.enviados.push(
      typeof dados === 'string'
        ? dados
        : dados instanceof ArrayBuffer
          ? new Uint8Array(dados)
          : new Uint8Array(dados.buffer, dados.byteOffset, dados.byteLength),
    );
  }
  close(): void {
    this.fechou = true;
  }
  abrir(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

function conectar() {
  let socket!: SocketFalso;
  const bytes: string[] = [];
  const estados: EstadoTerminal[] = [];
  const conexao = conectarTerminal(
    's1',
    {
      aoBytes: (d) => bytes.push(new TextDecoder().decode(d)),
      aoEstado: (e) => estados.push(e),
    },
    {
      origem: { protocol: 'http:', host: '127.0.0.1:4317' },
      criarSocket: (url) => (socket = new SocketFalso(url)),
    },
  );
  return { conexao, socket, bytes, estados };
}

describe('conectarTerminal (01 §8.1: teclas binárias, controle JSON)', () => {
  it('abre na mesma origem com binaryType arraybuffer', () => {
    const { socket } = conectar();
    expect(socket.url).toBe('ws://127.0.0.1:4317/api/terminal/s1');
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('teclas sobem como frame BINÁRIO; redimensionar como texto JSON', () => {
    const { conexao, socket } = conectar();
    conexao.enviarTeclas('ls\r'); // antes de abrir: descartado
    socket.abrir();
    conexao.enviarTeclas('{"tipo":"redimensionar","colunas":1,"linhas":1}');
    conexao.redimensionar(100.9, 30);
    const [tecla, controle] = socket.enviados;
    expect(tecla).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(tecla as Uint8Array)).toContain('redimensionar');
    expect(typeof controle).toBe('string');
    expect(JSON.parse(controle as string)).toEqual({
      tipo: 'redimensionar',
      colunas: 100,
      linhas: 30,
    });
  });

  it('bytes do PTY descem crus; controle de texto vira estado', () => {
    const { socket, bytes, estados } = conectar();
    socket.abrir();
    socket.onmessage?.({ data: new TextEncoder().encode('olá').buffer });
    socket.onmessage?.({ data: '{"tipo":"encerrado","codigo":0,"sinal":null}' });
    socket.onclose?.({ code: 1000 });
    expect(bytes).toEqual(['olá']);
    expect(estados).toEqual(['conectando', 'conectado', 'encerrado']);
  });

  it('queda sem "encerrado" = desconectado; fechar() local não avisa', () => {
    const a = conectar();
    a.socket.abrir();
    a.socket.onclose?.({ code: 1006 });
    expect(a.estados.at(-1)).toBe('desconectado');
    const b = conectar();
    b.socket.abrir();
    b.conexao.fechar();
    expect(b.socket.fechou).toBe(true);
    expect(b.estados.at(-1)).toBe('conectado');
  });

  it('lerControleServidor ignora o que não é controle', () => {
    expect(lerControleServidor('nada')).toBeNull();
    expect(lerControleServidor('{"tipo":"x"}')).toBeNull();
    expect(lerControleServidor('{"tipo":"scrollback_fim"}')).toEqual({ tipo: 'scrollback_fim' });
    expect(lerControleServidor('{"tipo":"scrollback_inicio"}')).toEqual({
      tipo: 'scrollback_inicio',
    });
    expect(lerControleServidor('{"tipo":"encerrado","codigo":0,"sinal":null}')).toEqual({
      tipo: 'encerrado',
      codigo: 0,
      sinal: null,
    });
    expect(lerControleServidor('{"tipo":"encerrado","codigo":"x"}')).toEqual({
      tipo: 'encerrado',
      codigo: null,
      sinal: null,
    });
  });
});
