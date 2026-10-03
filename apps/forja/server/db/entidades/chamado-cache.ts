import type { Complexidade, Natureza, Prioridade, StatusChamado } from '@chamados/shared';
import { EntitySchema } from 'typeorm';
import { SinaisCacheSchema, type SinaisCache } from '../json';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `chamado_cache` (specs/forja/02 §4.4): espelho do que a API do Chamados
 * devolve, para desenhar a fila e os sinais sem ir à rede. NÃO é verdade de
 * negócio: o detalhe é relido antes de toda ação (F-15).
 *
 * `ultima_mensagem_*` existe porque o `updated_at` remoto não muda quando chega
 * mensagem [V F-15]; `ia_silenciada` nulo = desconhecido (sem D-036 L1 só o
 * detalhe informa). Enums do Chamados vêm de `@chamados/shared` (F-18).
 */
export interface ChamadoCache extends ComTempo {
  id: string;
  conexao_id: string;
  chamado_id: string;
  numero: number;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  sistema_alvo_id: string | null;
  sistema_nome: string | null;
  operador_id: string | null;
  ia_silenciada: boolean | null;
  ultima_mensagem_id: string | null;
  ultima_mensagem_em: string | null;
  sinais: SinaisCache;
  atualizado_em_remoto: string | null;
  sincronizado_em: string;
  detalhe_sincronizado_em: string | null;
}

export const ChamadoCacheSchema = new EntitySchema<ChamadoCache>({
  name: 'ChamadoCache',
  tableName: 'chamado_cache',
  columns: {
    id: pk(),
    conexao_id: texto(),
    chamado_id: texto(),
    numero: inteiro(),
    titulo: texto(),
    status: texto(),
    natureza: texto(),
    prioridade: texto(),
    complexidade: texto(true),
    sistema_alvo_id: texto(true),
    sistema_nome: texto(true),
    operador_id: texto(true),
    ia_silenciada: booleano(true),
    ultima_mensagem_id: texto(true),
    ultima_mensagem_em: texto(true),
    sinais: json(SinaisCacheSchema, 'chamado_cache.sinais'),
    atualizado_em_remoto: texto(true),
    sincronizado_em: texto(),
    detalhe_sincronizado_em: texto(true),
    ...tempo(),
  },
  indices: [
    { name: 'ux_chamado_cache_chamado', columns: ['conexao_id', 'chamado_id'], unique: true },
    { name: 'ux_chamado_cache_numero', columns: ['conexao_id', 'numero'], unique: true },
    { name: 'ix_chamado_cache_status', columns: ['conexao_id', 'status'] },
    { name: 'ix_chamado_cache_sistema', columns: ['sistema_nome'] },
  ],
});
