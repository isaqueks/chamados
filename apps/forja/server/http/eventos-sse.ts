import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventoForja } from '../../comum/protocolo-eventos';
import { BarramentoEventos, LACUNA } from '../eventos/barramento';
import { cabecalhosSeguranca } from './seguranca-local';

/**
 * Canais SSE (specs/forja/01 §8.1): `GET /api/eventos` (global) e
 * `GET /api/execucoes/:id/eventos` (feed de uma execução).
 *
 * - `id: <seq>` em cada evento; na reconexão o navegador manda `Last-Event-ID`
 *   e o servidor reenvia tudo depois dele (a 1ª conexão pode passar o mesmo
 *   valor por `?ultimo_seq=`, já que `EventSource` não aceita cabeçalho).
 * - Heartbeat (comentário SSE) a cada 15 s para proxies e para detectar queda.
 * - Cada cliente tem um buffer limitado: se ele não drena (`write` devolve
 *   false) e o buffer enche, recebe `sistema.recarregar` e é desconectado. O
 *   publicador NUNCA espera um cliente lento (01 §8.1).
 * - Sem campo `event:`: todos chegam no `onmessage`, e o `tipo` vai no JSON.
 */

export const HEARTBEAT_MS = 15_000;
export const BUFFER_MAXIMO_CLIENTE = 1000;

/** Uma mensagem SSE com `id: seq`. JSON nunca tem quebra de linha crua. */
export function formatarEventoSse(evento: EventoForja): string {
  return `id: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`;
}

export const HEARTBEAT_SSE = ': hb\n\n';

/** `Last-Event-ID` (cabeçalho) ou `?ultimo_seq=` → número ≥ 0, ou null. */
export function interpretarUltimoId(valor: unknown): number | null {
  const bruto = Array.isArray(valor) ? valor[0] : valor;
  if (typeof bruto !== 'string' || !/^\d{1,15}$/.test(bruto.trim())) return null;
  return Number(bruto.trim());
}

/** Evento sintético de recarga (não persistido; seq = último conhecido). */
export function eventoRecarregar(
  seq: number,
  motivo: 'cliente_lento' | 'lacuna_no_historico',
): EventoForja {
  return {
    seq,
    em: new Date().toISOString(),
    execucao_id: null,
    etapa_id: null,
    tipo: 'sistema.recarregar',
    nivel: 'aviso',
    resumo: 'Recarregue a tela para continuar acompanhando',
    dados: { motivo },
  };
}

interface Saida {
  write(chunk: string): boolean;
  once(evento: 'drain', fn: () => void): unknown;
  end(): void;
}

/**
 * Fila de escrita de um cliente: escreve direto enquanto o socket aceita;
 * acumula enquanto espera `drain`; estoura → `aoEstourar`.
 */
export class ClienteSse {
  private pendentes: string[] = [];
  private esperandoDrain = false;
  private encerrado = false;

  constructor(
    private readonly saida: Saida,
    private readonly limite: number,
    private readonly aoEstourar: () => void,
  ) {}

  get fechado(): boolean {
    return this.encerrado;
  }

  enviar(texto: string): void {
    if (this.encerrado) return;
    if (this.esperandoDrain) {
      if (this.pendentes.length >= this.limite) {
        this.aoEstourar();
        return;
      }
      this.pendentes.push(texto);
      return;
    }
    if (!this.saida.write(texto)) {
      this.esperandoDrain = true;
      this.saida.once('drain', () => this.drenar());
    }
  }

  private drenar(): void {
    this.esperandoDrain = false;
    while (this.pendentes.length > 0 && !this.encerrado) {
      const proximo = this.pendentes.shift()!;
      if (!this.saida.write(proximo)) {
        this.esperandoDrain = true;
        this.saida.once('drain', () => this.drenar());
        return;
      }
    }
  }

  encerrar(ultimaMensagem?: string): void {
    if (this.encerrado) return;
    this.encerrado = true;
    this.pendentes = [];
    try {
      if (ultimaMensagem) this.saida.write(ultimaMensagem);
      this.saida.end();
    } catch {
      // socket já fechado
    }
  }
}

export interface OpcoesCanalSse {
  barramento: BarramentoEventos;
  porta: number;
  filtro: (evento: EventoForja) => boolean;
  heartbeatMs?: number;
  bufferMaximo?: number;
  /**
   * Replay persistente (SQLite, 02 §4.8): eventos com `seq > ultimo` que passam
   * no filtro; `null` = grande demais (vira `sistema.recarregar`). Ausente = só o
   * anel em memória do barramento (que um reboot zera).
   */
  replay?: (
    ultimo: number,
    filtro: (evento: EventoForja) => boolean,
  ) => Promise<EventoForja[] | null>;
}

/** Abre um stream SSE na resposta (hijack do Fastify) ligado ao barramento. */
export function abrirCanalSse(
  req: FastifyRequest,
  reply: FastifyReply,
  opcoes: OpcoesCanalSse,
): void {
  const { barramento, porta, filtro } = opcoes;
  const consulta = req.query as Record<string, unknown> | undefined;
  const ultimo =
    interpretarUltimoId(req.headers['last-event-id']) ?? interpretarUltimoId(consulta?.ultimo_seq);

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...cabecalhosSeguranca(porta, true),
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let cancelar: () => void = () => {};
  const cliente = new ClienteSse(res, opcoes.bufferMaximo ?? BUFFER_MAXIMO_CLIENTE, () => {
    cliente.encerrar(formatarEventoSse(eventoRecarregar(barramento.ultimoSeq, 'cliente_lento')));
    finalizar();
  });

  if (ultimo !== null && opcoes.replay) {
    // Replay ASSÍNCRONO (SQLite): assina primeiro e segura o que chegar ao vivo
    // enquanto o banco responde; depois entrega replay + segurados sem repetir
    // `seq` (A6: exatamente os perdidos, sem duplicata). O evento só é difundido
    // depois do commit, então tudo que já está no banco vem pelo replay.
    let segurados: EventoForja[] | null = [];
    let maiorEntregue = ultimo;
    const entregar = (e: EventoForja): void => {
      if (e.seq <= maiorEntregue) return;
      maiorEntregue = e.seq;
      cliente.enviar(formatarEventoSse(e));
    };
    cancelar = barramento.assinar((evento) => {
      if (!filtro(evento)) return;
      if (segurados) segurados.push(evento);
      else entregar(evento);
    });
    opcoes
      .replay(ultimo, filtro)
      .catch(() => null)
      .then((perdidos) => {
        if (cliente.fechado) return;
        if (perdidos === null) {
          cliente.enviar(
            formatarEventoSse(eventoRecarregar(barramento.ultimoSeq, 'lacuna_no_historico')),
          );
        } else {
          for (const e of perdidos) entregar(e);
        }
        const vivos = segurados ?? [];
        segurados = null;
        for (const e of vivos) entregar(e);
      });
  } else {
    // Replay do anel; depois, ao vivo. Como o barramento é síncrono, não há
    // janela entre o replay e a assinatura (nada é publicado no meio).
    if (ultimo !== null) {
      const perdidos = barramento.desde(ultimo, filtro);
      if (perdidos === LACUNA) {
        cliente.enviar(
          formatarEventoSse(eventoRecarregar(barramento.ultimoSeq, 'lacuna_no_historico')),
        );
      } else {
        for (const e of perdidos) cliente.enviar(formatarEventoSse(e));
      }
    }
    cancelar = barramento.assinar((evento) => {
      if (filtro(evento)) cliente.enviar(formatarEventoSse(evento));
    });
  }

  const heartbeat = setInterval(
    () => cliente.enviar(HEARTBEAT_SSE),
    opcoes.heartbeatMs ?? HEARTBEAT_MS,
  );
  heartbeat.unref();

  function finalizar(): void {
    clearInterval(heartbeat);
    cancelar();
  }

  req.raw.on('close', () => {
    finalizar();
    cliente.encerrar();
  });
}
