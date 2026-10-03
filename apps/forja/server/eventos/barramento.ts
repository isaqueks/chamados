import {
  pertenceAoCanalDaExecucao,
  pertenceAoCanalGlobal,
  type EventoForja,
  type NovoEventoForja,
} from '../../comum/protocolo-eventos';
import { AnelLimitado, FilaCliente, type SaidaCliente } from './anel';
import { enxugarEvento, type Redator } from './normalizador';
import { LIMITE_REPLAY_PADRAO, type MetaEvento, type PersistenciaEventos } from './persistencia';

/**
 * Barramento de eventos (specs/forja/01 §8). Atribui o `seq`, guarda os últimos
 * N eventos num anel (cache quente para a reconexão SSE com `Last-Event-ID`) e
 * entrega aos assinantes de forma SÍNCRONA e sem esperar ninguém — quem publica
 * é o leitor do stdout da CLI, que nunca pode bloquear por causa de um cliente
 * lento (01 §8.1, 04 §7.6 da pesquisa).
 *
 * Com `PersistenciaEventos` (SQLite, 02 §4.8) ligada:
 * - o `seq` vem do banco (`gravar` → seq) e o evento só chega à UI DEPOIS de
 *   persistido; se `gravar` lança, ninguém recebe o evento e o erro sobe para
 *   quem publicou (evento que a UI viu tem que existir no replay);
 * - `desde(seq)` que o anel já descartou cai no banco; só vira `LACUNA` quando
 *   nem o banco cobre (retenção) ou o replay passa do teto.
 *
 * Todo evento passa por `enxugarEvento` (payload ≤ 8 KB, texto truncado,
 * segredos redigidos — 05 §8.2) antes de ser numerado.
 *
 * Clientes (SSE/WS) se conectam por `conectarCliente`, que dá a cada um um
 * buffer em ANEL (`FilaCliente`): o cliente que não drena recebe
 * `sistema.recarregar` (`cliente_lento`) e é desligado.
 */

export type Assinante = (evento: EventoForja) => void;
export type FiltroEvento = (evento: EventoForja) => boolean;

/** `desde(seq)` não consegue reproduzir a partir de um `seq` mais antigo que o anel/banco. */
export const LACUNA = Symbol('lacuna');

export interface OpcoesBarramento {
  capacidade?: number;
  /** Último `seq` já persistido (sem `persistencia`; com ela, vem de `ultimoSeq()`). */
  seqInicial?: number;
  agora?: () => Date;
  persistencia?: PersistenciaEventos;
  /** Redator com os valores sensíveis conhecidos (token, `.env`, API key). */
  redator?: Redator;
  /** Teto do replay vindo do banco antes de preferir `sistema.recarregar`. */
  limiteReplay?: number;
}

export type MotivoRecarregar = 'cliente_lento' | 'lacuna_no_historico' | 'reinicio';

/** Evento sintético de recarga: NÃO persistido; `seq` = último conhecido (01 §8.1). */
export function criarEventoRecarregar(
  seq: number,
  motivo: MotivoRecarregar,
  em = new Date(),
): EventoForja {
  const evento: EventoForja = {
    seq,
    em: em.toISOString(),
    execucao_id: null,
    etapa_id: null,
    tipo: 'sistema.recarregar',
    nivel: 'aviso',
    resumo: 'Recarregue a tela para continuar acompanhando',
    dados: { motivo },
  };
  return evento;
}

/** Filtro do canal global `GET /api/eventos`. */
export const filtroCanalGlobal: FiltroEvento = (e) => pertenceAoCanalGlobal(e);

/** Filtro do canal `GET /api/execucoes/:id/eventos`. */
export function filtroCanalExecucao(execucaoId: string): FiltroEvento {
  return (e) => pertenceAoCanalDaExecucao(e, execucaoId);
}

export interface OpcoesCliente {
  /** Destino; `escrever` devolve false quando o socket pede espera. */
  saida: SaidaCliente<EventoForja>;
  filtro?: FiltroEvento;
  /** `Last-Event-ID` (null = só ao vivo). */
  ultimoSeq?: number | null;
  /** Tamanho do anel do cliente (eventos pendentes). */
  capacidade?: number;
  /** Cliente lento: recebe o evento de recarga para escrever por último e fechar. */
  aoEstourar: (recarregar: EventoForja) => void;
}

export interface ConexaoCliente {
  cancelar(): void;
  readonly fila: FilaCliente<EventoForja>;
}

export const CAPACIDADE_CLIENTE_PADRAO = 1000;

export class BarramentoEventos {
  private readonly anel: AnelLimitado<EventoForja>;
  private readonly assinantes = new Map<Assinante, FiltroEvento | undefined>();
  private readonly agora: () => Date;
  private readonly persistencia: PersistenciaEventos | undefined;
  private readonly redator: Redator | undefined;
  private readonly limiteReplay: number;
  private seq: number;

  constructor(opcoes: OpcoesBarramento = {}) {
    this.anel = new AnelLimitado(opcoes.capacidade ?? 5000);
    this.persistencia = opcoes.persistencia;
    this.redator = opcoes.redator;
    this.limiteReplay = opcoes.limiteReplay ?? LIMITE_REPLAY_PADRAO;
    this.seq = this.persistencia ? this.persistencia.ultimoSeq() : (opcoes.seqInicial ?? 0);
    this.agora = opcoes.agora ?? (() => new Date());
  }

  get ultimoSeq(): number {
    return this.seq;
  }

  get totalAssinantes(): number {
    return this.assinantes.size;
  }

  publicar(novo: NovoEventoForja, meta: MetaEvento = { origem: 'app' }): EventoForja {
    const enxuto = enxugarEvento(novo, { redator: this.redator });
    const em = this.agora().toISOString();
    if (this.persistencia) {
      this.seq = this.persistencia.gravar({ ...enxuto, em, meta });
    } else {
      this.seq += 1;
    }
    const evento = { ...enxuto, seq: this.seq, em } as EventoForja;
    this.anel.push(evento);
    for (const [assinante, filtro] of this.assinantes) {
      try {
        if (filtro && !filtro(evento)) continue;
        assinante(evento);
      } catch {
        // Um assinante com defeito nunca derruba quem publica.
      }
    }
    return evento;
  }

  /**
   * Difunde um envelope JÁ persistido pelo SQLite (`PersistenciaEventosSqlite.
   * registrar`, assíncrona) com o `seq` do banco. POR QUE à parte de `publicar`:
   * o orquestrador grava o evento na MESMA transação da transição de estado
   * (03 §1.4) e só depois do commit o entrega aos clientes — o `seq` do SSE é o
   * do banco, e o replay (`desde`) bate com o que foi ao vivo.
   */
  difundir(evento: EventoForja): EventoForja {
    if (evento.seq > this.seq) this.seq = evento.seq;
    this.anel.push(evento);
    for (const [assinante, filtro] of this.assinantes) {
      try {
        if (filtro && !filtro(evento)) continue;
        assinante(evento);
      } catch {
        // Um assinante com defeito nunca derruba quem publica.
      }
    }
    return evento;
  }

  /** Assina (com filtro opcional, ex.: por execução). Devolve o cancelamento. */
  assinar(assinante: Assinante, filtro?: FiltroEvento): () => void {
    this.assinantes.set(assinante, filtro);
    return () => {
      this.assinantes.delete(assinante);
    };
  }

  /**
   * Eventos com `seq > ultimoSeq` que passam no filtro, em ordem. Devolve
   * `LACUNA` quando nem o anel nem a persistência cobrem o pedido (a UI recebe
   * `sistema.recarregar` e refaz o carregamento completo).
   */
  desde(ultimoSeq: number, filtro: FiltroEvento = () => true): EventoForja[] | typeof LACUNA {
    if (ultimoSeq >= this.seq) return [];
    const maisAntigo = this.anel.primeiro()?.seq ?? this.seq + 1;
    if (ultimoSeq + 1 >= maisAntigo) {
      return this.anel.paraArray().filter((e) => e.seq > ultimoSeq && filtro(e));
    }
    if (!this.persistencia) return LACUNA;
    const doBanco = this.persistencia.desde(ultimoSeq, { limite: this.limiteReplay });
    // Um salto de `seq` no banco é normal (AUTOINCREMENT pula após ROLLBACK).
    return doBanco === null ? LACUNA : doBanco.filter(filtro);
  }

  /**
   * Conecta um cliente com buffer em anel: replay a partir de `ultimoSeq`
   * (ou recarga, se houver lacuna) e depois ao vivo. Como `publicar` é
   * síncrono, não há janela entre o replay e a assinatura.
   */
  conectarCliente(opcoes: OpcoesCliente): ConexaoCliente {
    const filtro = opcoes.filtro ?? (() => true);
    let cancelado = false;
    let cancelarAssinatura: () => void = () => {};
    const cancelar = (): void => {
      cancelado = true;
      cancelarAssinatura();
    };
    const fila = new FilaCliente<EventoForja>(
      opcoes.saida,
      opcoes.capacidade ?? CAPACIDADE_CLIENTE_PADRAO,
      () => {
        cancelar();
        opcoes.aoEstourar(criarEventoRecarregar(this.seq, 'cliente_lento', this.agora()));
      },
    );

    if (opcoes.ultimoSeq !== undefined && opcoes.ultimoSeq !== null) {
      const perdidos = this.desde(opcoes.ultimoSeq, filtro);
      if (perdidos === LACUNA) {
        fila.enviar(criarEventoRecarregar(this.seq, 'lacuna_no_historico', this.agora()));
      } else {
        for (const e of perdidos) fila.enviar(e);
      }
    }
    if (!cancelado && !fila.estourou) {
      cancelarAssinatura = this.assinar((e) => fila.enviar(e), filtro);
    }
    return { cancelar, fila };
  }
}
