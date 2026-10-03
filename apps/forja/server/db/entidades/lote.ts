import { EntitySchema } from 'typeorm';
import type { EstadoLote } from '../../../comum/estados';
import { inteiro, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `lote` (specs/forja/02 §4.5): seleção múltipla de UM projeto (N projetos na
 * seleção = N lotes). Planos em paralelo → mesa de planos → implementação
 * (F-14). As concorrências são snapshot de `limites.concorrencia` no início,
 * para o lote não mudar de comportamento se o projeto for editado no meio.
 */
export interface Lote extends ComTempo {
  id: string;
  projeto_id: string;
  nome: string;
  estado: EstadoLote;
  concorrencia_planos: number;
  concorrencia_impl: number;
  encerrado_em: string | null;
}

export const LoteSchema = new EntitySchema<Lote>({
  name: 'Lote',
  tableName: 'lote',
  columns: {
    id: pk(),
    projeto_id: texto(),
    nome: texto(),
    estado: texto(),
    concorrencia_planos: inteiro(),
    concorrencia_impl: inteiro(),
    encerrado_em: texto(true),
    ...tempo(),
  },
  indices: [{ name: 'ix_lote_projeto', columns: ['projeto_id', 'estado'] }],
});
