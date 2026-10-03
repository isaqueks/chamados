import type { OrigemEvento, PapelAgente } from '../../../comum/estados';
import type {
  EventoForja,
  NovoEventoForja,
  TipoEventoForja,
} from '../../../comum/protocolo-eventos';
import { EventoSchema, type Evento } from '../entidades/evento';
import type { JsonLivre } from '../json';
import { RepositorioBase } from './base';

/**
 * Repositório de `evento` (specs/forja/02 §4.8, invariante I-7). Append-only:
 * não há update; o único DELETE é o expurgo da retenção (02 §9), por execução
 * encerrada, que preserva os eventos de origem `app`/`humano` (auditoria).
 *
 * O envelope `EventoForja` (01 §8.2) é guardado coluna a coluna: `seq` é a PK
 * AUTOINCREMENT, `em` é `criado_em`, `dados` vai em `payload` ENXUTO (≤ 8 KB —
 * strings longas e listas grandes são cortadas; o bruto está em
 * `eventos.jsonl`), e `papel_agente`/`parent_tool_use_id` são copiados de
 * `dados` para colunas próprias (filtro da árvore Fable → Opus).
 */

export const LIMITE_PAYLOAD_BYTES = 8 * 1024;
const MARCA_CORTE = '…';

export interface OpcoesGravacaoEvento {
  /** Default: derivada do tipo (`origemPadrao`). */
  origem?: OrigemEvento;
  /** Linha correspondente em `etapas/<n>/eventos.jsonl`. */
  linha_bruta?: number | null;
  /** ISO do envelope; default agora. */
  em?: string;
}

export interface FiltroEventosSql {
  execucao_id?: string;
  etapa_id?: string;
  tipos?: readonly TipoEventoForja[];
  limite?: number;
}

/** De onde vem cada tipo do catálogo, quando quem grava não diz. */
export function origemPadrao(tipo: TipoEventoForja): OrigemEvento {
  if (
    tipo.startsWith('agente.') ||
    tipo.startsWith('subagente.') ||
    tipo === 'permissao.negada' ||
    tipo === 'telemetria.turno' ||
    tipo === 'uso.atualizado' ||
    tipo === 'cli.alerta'
  ) {
    return 'cli';
  }
  if (tipo === 'verificacao.comando') return 'comando';
  if (tipo === 'chamado.sinal') return 'chamados';
  return 'app';
}

function tamanho(valor: unknown): number {
  return Buffer.byteLength(JSON.stringify(valor), 'utf8');
}

function cortar(valor: unknown, maxTexto: number, maxLista: number): unknown {
  if (typeof valor === 'string') {
    return valor.length > maxTexto ? valor.slice(0, maxTexto) + MARCA_CORTE : valor;
  }
  if (Array.isArray(valor)) {
    return valor.slice(0, maxLista).map((v) => cortar(v, maxTexto, maxLista));
  }
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, cortar(v, maxTexto, maxLista)]),
    );
  }
  return valor;
}

/**
 * Recorte enxuto do `dados` (02 §4.8: "≤ 8 KB; acima disso trunca"). Corta em
 * passos cada vez mais agressivos, preservando a FORMA (chaves e tipos), para o
 * replay continuar desenhável pela UI.
 */
export function enxugarPayload(dados: unknown): unknown {
  if (tamanho(dados) <= LIMITE_PAYLOAD_BYTES) return dados;
  for (const [maxTexto, maxLista] of [
    [2000, 50],
    [500, 20],
    [120, 5],
    [40, 2],
  ] as const) {
    const cortado = cortar(dados, maxTexto, maxLista);
    if (tamanho(cortado) <= LIMITE_PAYLOAD_BYTES) return cortado;
  }
  return cortar(dados, 16, 1);
}

function campoTexto(dados: unknown, campo: string): string | null {
  if (dados && typeof dados === 'object' && campo in dados) {
    const v = (dados as Record<string, unknown>)[campo];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** Reconstrói o envelope publicado a partir da linha (replay do SSE). */
export function eventoDaLinha(linha: Evento): EventoForja {
  return {
    seq: linha.seq,
    em: linha.criado_em,
    execucao_id: linha.execucao_id,
    etapa_id: linha.etapa_id,
    tipo: linha.tipo,
    nivel: linha.nivel,
    resumo: linha.resumo,
    dados: linha.payload ?? {},
  } as EventoForja;
}

export class RepositorioEventos extends RepositorioBase {
  /** Acrescenta um evento e devolve o envelope com `seq`/`em` atribuídos. */
  async acrescentar(
    novo: NovoEventoForja,
    opcoes: OpcoesGravacaoEvento = {},
  ): Promise<EventoForja> {
    const em = opcoes.em ?? this.agora();
    const payload = enxugarPayload(novo.dados) as JsonLivre;
    const linha: Omit<Evento, 'seq'> = {
      execucao_id: novo.execucao_id,
      etapa_id: novo.etapa_id,
      origem: opcoes.origem ?? origemPadrao(novo.tipo),
      tipo: novo.tipo,
      nivel: novo.nivel,
      papel_agente: campoTexto(novo.dados, 'papel_agente') as PapelAgente | null,
      parent_tool_use_id: campoTexto(novo.dados, 'parent_tool_use_id'),
      resumo: novo.resumo,
      payload,
      linha_bruta: opcoes.linha_bruta ?? null,
      criado_em: em,
    };
    await this.inserir(EventoSchema, linha);
    const [{ seq }] = (await this.m.query('SELECT last_insert_rowid() AS seq')) as [
      { seq: number },
    ];
    return { ...novo, dados: payload, seq, em } as EventoForja;
  }

  /** Eventos com `seq > seq`, em ordem crescente. */
  async desde(seq: number, filtro: FiltroEventosSql = {}): Promise<EventoForja[]> {
    const qb = this.m
      .createQueryBuilder(EventoSchema, 'e')
      .where('e.seq > :seq', { seq })
      .orderBy('e.seq', 'ASC');
    if (filtro.execucao_id) qb.andWhere('e.execucao_id = :x', { x: filtro.execucao_id });
    if (filtro.etapa_id) qb.andWhere('e.etapa_id = :t', { t: filtro.etapa_id });
    if (filtro.tipos) {
      if (filtro.tipos.length === 0) return [];
      qb.andWhere('e.tipo IN (:...tipos)', { tipos: filtro.tipos });
    }
    if (filtro.limite !== undefined) qb.limit(filtro.limite);
    return (await qb.getMany()).map(eventoDaLinha);
  }

  async ultimoSeq(): Promise<number> {
    const linhas = (await this.m.query('SELECT MAX("seq") AS seq FROM "evento"')) as {
      seq: number | null;
    }[];
    return linhas[0]?.seq ?? 0;
  }

  /**
   * Retenção (02 §9): apaga eventos das execuções dadas (já encerradas — quem
   * chama confere) até `ateSeq`, mantendo os de origem `app`/`humano`.
   */
  async expurgar(execucaoIds: string[], ateSeq?: number): Promise<number> {
    if (execucaoIds.length === 0) return 0;
    const qb = this.m
      .createQueryBuilder()
      .delete()
      .from(EventoSchema)
      .where('execucao_id IN (:...ids)', { ids: execucaoIds })
      .andWhere(`origem NOT IN ('app', 'humano')`);
    if (ateSeq !== undefined) qb.andWhere('seq <= :ate', { ate: ateSeq });
    const r = await qb.execute();
    return r.affected ?? 0;
  }
}
