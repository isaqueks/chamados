import type { EventoForja, NovoEventoForja, TipoEventoForja } from '../../comum/protocolo-eventos';
import type { BancoForja } from './banco';
import type { OpcoesGravacaoEvento } from './repositorios/evento';

/**
 * Persistência append-only dos eventos (specs/forja/02 §4.8, I-7; 01 §8).
 *
 * POR QUE uma interface: o barramento (`server/eventos/barramento.ts`) hoje
 * numera em memória; com o SQLite, o `seq` passa a vir do AUTOINCREMENT de
 * `evento` e o replay do SSE (`Last-Event-ID`) passa a ler daqui, com o anel em
 * memória só como cache quente. A ligação barramento ⇄ persistência é feita no
 * boot (R3); este módulo só define o contrato e a implementação SQLite.
 *
 * Ordem segura de publicação: grave primeiro, publique o envelope DEVOLVIDO
 * depois que a transação confirmou. Se `gravar` rodar dentro de uma
 * `banco.transacao(...)` maior e ela fizer ROLLBACK, o `seq` pode ser
 * reaproveitado — então nada desse evento pode ter ido ao SSE antes do commit.
 */

export interface FiltroEventos {
  execucao_id?: string;
  etapa_id?: string;
  tipos?: readonly TipoEventoForja[];
  /** Filtro em memória aplicado depois do SQL (ex.: `pertenceAoCanalGlobal`). */
  predicado?: (evento: EventoForja) => boolean;
  /** Máximo devolvido (default `LIMITE_REPLAY`). */
  limite?: number;
}

export interface PersistenciaEventos {
  /** Grava e devolve o `seq` atribuído. */
  gravar(evento: NovoEventoForja, opcoes?: OpcoesGravacaoEvento): Promise<number>;
  /** Grava e devolve o envelope completo (`seq`, `em`, `dados` enxuto) — o que se publica. */
  registrar(evento: NovoEventoForja, opcoes?: OpcoesGravacaoEvento): Promise<EventoForja>;
  /** Eventos com `seq` maior que o dado, em ordem (replay do SSE). */
  desde(seq: number, filtro?: FiltroEventos): Promise<EventoForja[]>;
  /** Maior `seq` gravado (0 se vazio) — `seqInicial` do barramento após reboot. */
  ultimoSeq(): Promise<number>;
}

export const LIMITE_REPLAY = 5000;
const PAGINA = 500;

export class PersistenciaEventosSqlite implements PersistenciaEventos {
  constructor(private readonly banco: BancoForja) {}

  async gravar(evento: NovoEventoForja, opcoes?: OpcoesGravacaoEvento): Promise<number> {
    return (await this.registrar(evento, opcoes)).seq;
  }

  registrar(evento: NovoEventoForja, opcoes?: OpcoesGravacaoEvento): Promise<EventoForja> {
    return this.banco.transacao((r) => r.eventos.acrescentar(evento, opcoes));
  }

  async desde(seq: number, filtro: FiltroEventos = {}): Promise<EventoForja[]> {
    const limite = filtro.limite ?? LIMITE_REPLAY;
    const { predicado, limite: _limite, ...sql } = filtro;
    if (!predicado) {
      return this.banco.ler((r) => r.eventos.desde(seq, { ...sql, limite }));
    }
    const saida: EventoForja[] = [];
    let cursor = seq;
    while (saida.length < limite) {
      const pagina = await this.banco.ler((r) =>
        r.eventos.desde(cursor, { ...sql, limite: PAGINA }),
      );
      for (const e of pagina) {
        if (predicado(e)) saida.push(e);
        if (saida.length >= limite) break;
      }
      if (pagina.length < PAGINA) break;
      cursor = pagina[pagina.length - 1]!.seq;
    }
    return saida;
  }

  ultimoSeq(): Promise<number> {
    return this.banco.ler((r) => r.eventos.ultimoSeq());
  }
}
