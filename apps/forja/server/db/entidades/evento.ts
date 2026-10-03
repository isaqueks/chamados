import { EntitySchema } from 'typeorm';
import type { OrigemEvento, PapelAgente } from '../../../comum/estados';
import type { NivelEvento, TipoEventoForja } from '../../../comum/protocolo-eventos';
import { JsonLivre, type JsonLivre as TJsonLivre } from '../json';
import { inteiro, json, texto } from './colunas';

/**
 * `evento` (specs/forja/02 §4.8): log append-only de tudo o que a UI desenha.
 * `seq INTEGER PRIMARY KEY AUTOINCREMENT` é o `id:` do SSE e o `Last-Event-ID`
 * da reconexão: monotônico e nunca reutilizado (I-7) — por isso AUTOINCREMENT
 * (sem ele o SQLite reaproveitaria o maior rowid apagado pela retenção).
 *
 * Só `criado_em` (é o `em` do envelope `EventoForja`). `nivel` guarda o
 * `EventoForja.nivel` (01 §8.2) para o replay devolver o envelope idêntico ao
 * publicado; `payload` é o `dados` enxuto (≤ 8 KB) — o bruto fica em
 * `etapas/<n>/eventos.jsonl`, apontado por `linha_bruta`.
 */
export interface Evento {
  seq: number;
  execucao_id: string | null;
  etapa_id: string | null;
  origem: OrigemEvento;
  tipo: TipoEventoForja;
  nivel: NivelEvento;
  papel_agente: PapelAgente | null;
  parent_tool_use_id: string | null;
  resumo: string;
  payload: TJsonLivre | null;
  linha_bruta: number | null;
  criado_em: string;
}

export const EventoSchema = new EntitySchema<Evento>({
  name: 'Evento',
  tableName: 'evento',
  columns: {
    seq: { type: 'integer', primary: true, generated: 'increment' },
    execucao_id: texto(true),
    etapa_id: texto(true),
    origem: texto(),
    tipo: texto(),
    nivel: texto(),
    papel_agente: texto(true),
    parent_tool_use_id: texto(true),
    resumo: texto(),
    payload: json(JsonLivre, 'evento.payload', true),
    linha_bruta: inteiro(true),
    criado_em: texto(),
  },
  indices: [
    { name: 'ix_evento_execucao_seq', columns: ['execucao_id', 'seq'] },
    { name: 'ix_evento_etapa_seq', columns: ['etapa_id', 'seq'] },
  ],
});
