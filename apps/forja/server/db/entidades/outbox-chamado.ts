import { EntitySchema } from 'typeorm';
import type { EstadoOutbox, PassoOutbox } from '../../../comum/estados';
import { inteiro, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `outbox_chamado` (specs/forja/02 §4.13): uma linha por escrita no Chamados,
 * executada em ordem pelo despachante (03 §9). I-4: UNIQUE
 * `(execucao_id, passo, rodada)` — o encerramento é a rodada 0, então nele a
 * chave efetiva é `(execucao_id, passo)` e um passo nunca é enfileirado duas
 * vezes; rodada k ≥ 1 = k-ésima pergunta ao cliente (Gdec).
 *
 * Idempotência no servidor (07 §9): marcador `[forja:<execucao_id>:<momento>]`
 * na nota interna e `corpo_hash` (sha256 do corpo normalizado) + autor + janela
 * de tempo na pública.
 */
export interface OutboxChamado extends ComTempo {
  id: string;
  execucao_id: string;
  passo: PassoOutbox;
  estado: EstadoOutbox;
  rodada: number;
  ordem: number;
  corpo: string | null;
  corpo_hash: string | null;
  status_alvo: string | null;
  motivo: string | null;
  tentativas: number;
  proxima_em: string | null;
  ultimo_http: number | null;
  erro: string | null;
  id_remoto: string | null;
  enviado_em: string | null;
}

export const OutboxChamadoSchema = new EntitySchema<OutboxChamado>({
  name: 'OutboxChamado',
  tableName: 'outbox_chamado',
  columns: {
    id: pk(),
    execucao_id: texto(),
    passo: texto(),
    estado: texto(),
    rodada: inteiro(),
    ordem: inteiro(),
    corpo: texto(true),
    corpo_hash: texto(true),
    status_alvo: texto(true),
    motivo: texto(true),
    tentativas: inteiro(),
    proxima_em: texto(true),
    ultimo_http: inteiro(true),
    erro: texto(true),
    id_remoto: texto(true),
    enviado_em: texto(true),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_outbox_passo_rodada',
      columns: ['execucao_id', 'passo', 'rodada'],
      unique: true,
    },
    { name: 'ix_outbox_estado_proxima', columns: ['estado', 'proxima_em'] },
  ],
});
