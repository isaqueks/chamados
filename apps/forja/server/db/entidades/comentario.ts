import { EntitySchema } from 'typeorm';
import type { AlvoComentario } from '../../../comum/estados';
import { inteiro, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `comentario` (specs/forja/02 §4.10): feedback humano que vira insumo do
 * próximo ciclo (J6). Vai ao condutor NO PROMPT, nunca por arquivo gravável
 * (F-03, critica C-1) — por isso mora aqui e `consumido_em` marca quando entrou
 * no prompt de um turno T1. `arquivo`/`linha` já existem para o comentário por
 * linha do diff (UI rica = Fase 2).
 */
export interface Comentario extends ComTempo {
  id: string;
  execucao_id: string;
  artefato_id: string | null;
  alvo: AlvoComentario;
  arquivo: string | null;
  linha: number | null;
  texto: string;
  ciclo_destino: number;
  consumido_em: string | null;
}

export const ComentarioSchema = new EntitySchema<Comentario>({
  name: 'Comentario',
  tableName: 'comentario',
  columns: {
    id: pk(),
    execucao_id: texto(),
    artefato_id: texto(true),
    alvo: texto(),
    arquivo: texto(true),
    linha: inteiro(true),
    texto: texto(),
    ciclo_destino: inteiro(),
    consumido_em: texto(true),
    ...tempo(),
  },
  indices: [{ name: 'ix_comentario_execucao', columns: ['execucao_id', 'ciclo_destino'] }],
});
