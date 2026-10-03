import type { EventoForja } from '@comum/protocolo-eventos';

/**
 * Assinatura SSE da SPA (specs/forja/01 §8.1). O servidor numera cada evento
 * com `id: seq`. O `EventSource` reconecta sozinho com `Last-Event-ID` quando a
 * conexão cai aberta; quando o servidor FECHA (reinício, 5xx), ele desiste — aí
 * reconectamos nós, com backoff, passando `?ultimo_seq=` (EventSource não
 * aceita cabeçalho). Eventos já vistos são descartados (sem duplicata, A6).
 *
 * `sistema.recarregar` (cliente lento ou lacuna no histórico) não é repassado
 * como evento comum: chama `aoRecarregar` para a tela refazer o carregamento.
 */

export type EstadoConexaoSse = 'conectando' | 'conectado' | 'reconectando' | 'fechado';

/** Backoff exponencial 1 s, 2 s, 4 s… teto 30 s. */
export function proximoAtraso(tentativa: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, tentativa));
}

export function montarUrlSse(caminho: string, ultimoSeq: number | null): string {
  if (ultimoSeq === null) return caminho;
  const sep = caminho.includes('?') ? '&' : '?';
  return `${caminho}${sep}ultimo_seq=${ultimoSeq}`;
}

/** Aceita só eventos novos (seq estritamente maior que o último visto). */
export function eventoNovo(seq: number, ultimoSeq: number | null): boolean {
  return ultimoSeq === null || seq > ultimoSeq;
}

export interface OpcoesSse {
  /** Caminho da rota SSE (`/api/eventos` ou `/api/execucoes/:id/eventos`). */
  caminho: string;
  /** Último `seq` já carregado pela tela (ex.: `FeedDto.ultimo_seq`). */
  ultimoSeq?: number | null;
  aoEvento: (evento: EventoForja) => void;
  aoRecarregar?: () => void;
  aoEstado?: (estado: EstadoConexaoSse) => void;
}

export interface AssinaturaSse {
  fechar(): void;
  readonly ultimoSeq: number | null;
}

export function assinarSse(opcoes: OpcoesSse): AssinaturaSse {
  let ultimoSeq: number | null = opcoes.ultimoSeq ?? null;
  let fonte: EventSource | null = null;
  let tentativa = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fechado = false;

  const estado = (e: EstadoConexaoSse) => opcoes.aoEstado?.(e);

  function conectar(): void {
    if (fechado) return;
    estado(tentativa === 0 ? 'conectando' : 'reconectando');
    fonte = new EventSource(montarUrlSse(opcoes.caminho, ultimoSeq), { withCredentials: true });

    fonte.onopen = () => {
      tentativa = 0;
      estado('conectado');
    };

    fonte.onmessage = (msg: MessageEvent<string>) => {
      let evento: EventoForja;
      try {
        evento = JSON.parse(msg.data) as EventoForja;
      } catch {
        return;
      }
      if (evento.tipo === 'sistema.recarregar') {
        opcoes.aoRecarregar?.();
        return;
      }
      if (!eventoNovo(evento.seq, ultimoSeq)) return;
      ultimoSeq = evento.seq;
      opcoes.aoEvento(evento);
    };

    fonte.onerror = () => {
      if (fechado || !fonte) return;
      if (fonte.readyState === EventSource.CLOSED) {
        fonte.close();
        estado('reconectando');
        timer = setTimeout(conectar, proximoAtraso(tentativa));
        tentativa += 1;
      } else {
        estado('reconectando');
      }
    };
  }

  conectar();

  return {
    fechar() {
      fechado = true;
      if (timer) clearTimeout(timer);
      fonte?.close();
      estado('fechado');
    },
    get ultimoSeq() {
      return ultimoSeq;
    },
  };
}
