import type { OrigemEvento, PapelAgente } from '../../comum/estados';
import type { EventoForja, NovoEventoForja } from '../../comum/protocolo-eventos';

/**
 * Contrato da persistência append-only dos eventos (specs/forja/01 §8, 02 §4.8).
 *
 * POR QUE o banco é a fonte do `seq`: o `seq` é o `id:` do SSE e o
 * `Last-Event-ID` da reconexão — se viesse de um contador em memória, um
 * reboot recomeçaria do 1 e a UI descartaria eventos novos como "já vistos".
 * `evento.seq` é `INTEGER PRIMARY KEY AUTOINCREMENT` (nunca reutilizado), e o
 * barramento só entrega à UI DEPOIS de `gravar` devolver o `seq`: "todo evento
 * fica no SQLite antes de chegar à UI" (01 §6.7).
 *
 * POR QUE síncrono: better-sqlite3 é síncrono e o processo é o único escritor;
 * um `INSERT` por evento no mesmo tick mantém a ordem total sem fila.
 *
 * Este arquivo define a interface que `server/db` (R2-DB) implementa e um
 * adaptador em memória (testes, e boot antes das migrations).
 */

/** Colunas de `evento` que não estão no envelope (02 §4.8). */
export interface MetaEvento {
  origem: OrigemEvento;
  papel_agente?: PapelAgente | null;
  parent_tool_use_id?: string | null;
  /** Linha do `eventos.jsonl` da etapa com o bruto (1-based). */
  linha_bruta?: number | null;
}

/** O que se grava: envelope já enxuto + `em` atribuído + metadados. */
export type EventoAGravar = NovoEventoForja & { em: string; meta: MetaEvento };

export interface OpcoesDesde {
  /** Teto de linhas; acima disso `desde` devolve `null` (a UI recarrega). */
  limite?: number;
  /** Filtra por execução (canal `GET /api/execucoes/:id/eventos`). */
  execucao_id?: string;
}

export interface PersistenciaEventos {
  /** INSERT append-only; devolve o `seq` atribuído pelo banco. */
  gravar(evento: EventoAGravar): number;
  /**
   * Eventos com `seq > seq`, em ordem crescente. `null` quando passam de
   * `limite` (replay grande demais: melhor `sistema.recarregar`).
   */
  desde(seq: number, opcoes?: OpcoesDesde): EventoForja[] | null;
  /** Maior `seq` gravado (0 com a tabela vazia). */
  ultimoSeq(): number;
}

export const LIMITE_REPLAY_PADRAO = 10_000;

/** Adaptador em memória: mesma semântica do SQLite, sem retenção. */
export class PersistenciaEventosMemoria implements PersistenciaEventos {
  private readonly eventos: (EventoForja & { meta: MetaEvento })[] = [];
  private seq: number;

  constructor(seqInicial = 0) {
    this.seq = seqInicial;
  }

  gravar(evento: EventoAGravar): number {
    this.seq += 1;
    this.eventos.push({ ...evento, seq: this.seq } as EventoForja & { meta: MetaEvento });
    return this.seq;
  }

  desde(seq: number, opcoes: OpcoesDesde = {}): EventoForja[] | null {
    const limite = opcoes.limite ?? LIMITE_REPLAY_PADRAO;
    const saida: EventoForja[] = [];
    for (const e of this.eventos) {
      if (e.seq <= seq) continue;
      if (opcoes.execucao_id !== undefined && e.execucao_id !== opcoes.execucao_id) continue;
      if (saida.length >= limite) return null;
      const { meta: _meta, ...envelope } = e;
      saida.push(envelope as EventoForja);
    }
    return saida;
  }

  ultimoSeq(): number {
    return this.seq;
  }

  /** Só para testes/diagnóstico: metadados gravados de um `seq`. */
  metaDe(seq: number): MetaEvento | undefined {
    return this.eventos.find((e) => e.seq === seq)?.meta;
  }
}
