import { EntitySchema } from 'typeorm';
import type { DecisaoAprovacao, PoliticaStatus, TipoAprovacao } from '../../../comum/estados';
import { ValidacaoAprovacaoSchema, type ValidacaoAprovacao } from '../json';
import { SQL_APROVACAO_VIGENTE } from '../sql';
import { booleano, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `aprovacao` (specs/forja/02 §4.11): registro IMUTÁVEL de cada decisão humana
 * num gate (G1, Gdec, G2, G2', Gdeploy). A final é individual e amarrada a
 * `patch_id` + `sha` (F-11): mudou o patch, a aprovação é invalidada
 * (`invalidada_em` — a única coluna que muda depois de gravada) e nasce uma
 * `reaprovacao`.
 *
 * I-3 no banco: CHECK `ck_aprovacao_final_patch` (final/reaprovação exigem
 * patch_id e sha e nunca são em bloco) + único parcial da vigente. A exigência
 * de "aprovar sem prints" depende da execução e é regra do app na mesma
 * transação; o CHECK só impede o selo fora de final/reaprovação.
 */
export interface Aprovacao extends ComTempo {
  id: string;
  execucao_id: string;
  tipo: TipoAprovacao;
  decisao: DecisaoAprovacao;
  artefato_id: string | null;
  patch_id: string | null;
  sha: string | null;
  texto_resposta: string | null;
  validacao_resposta: ValidacaoAprovacao | null;
  aprovado_sem_prints: boolean;
  politica_status: PoliticaStatus | null;
  comentario: string | null;
  ciente_mensagem_id: string | null;
  em_bloco: boolean;
  lote_id: string | null;
  invalidada_em: string | null;
  motivo_invalidacao: string | null;
}

export const AprovacaoSchema = new EntitySchema<Aprovacao>({
  name: 'Aprovacao',
  tableName: 'aprovacao',
  columns: {
    id: pk(),
    execucao_id: texto(),
    tipo: texto(),
    decisao: texto(),
    artefato_id: texto(true),
    patch_id: texto(true),
    sha: texto(true),
    texto_resposta: texto(true),
    validacao_resposta: json(ValidacaoAprovacaoSchema, 'aprovacao.validacao_resposta', true),
    aprovado_sem_prints: booleano(),
    politica_status: texto(true),
    comentario: texto(true),
    ciente_mensagem_id: texto(true),
    em_bloco: booleano(),
    lote_id: texto(true),
    invalidada_em: texto(true),
    motivo_invalidacao: texto(true),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_aprovacao_vigente',
      columns: ['execucao_id'],
      unique: true,
      where: SQL_APROVACAO_VIGENTE,
    },
    { name: 'ix_aprovacao_execucao', columns: ['execucao_id', 'criado_em'] },
  ],
  checks: [
    {
      name: 'ck_aprovacao_final_patch',
      expression: `"tipo" NOT IN ('final', 'reaprovacao') OR ("patch_id" IS NOT NULL AND "sha" IS NOT NULL AND "em_bloco" = 0)`,
    },
    {
      name: 'ck_aprovacao_sem_prints',
      expression: `"aprovado_sem_prints" = 0 OR "tipo" IN ('final', 'reaprovacao')`,
    },
    {
      name: 'ck_aprovacao_em_bloco',
      expression: `"em_bloco" = 0 OR ("tipo" = 'plano' AND "lote_id" IS NOT NULL)`,
    },
  ],
});
