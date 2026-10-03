import { EntitySchema } from 'typeorm';
import type { ConfigResolvida } from '../../../comum/config-projeto';
import type {
  EstadoExecucao,
  EvidenciaVisual,
  MotivoEstado,
  NivelVerificacao,
} from '../../../comum/estados';
import {
  ConfigResolvidaSchema,
  SelosSchema,
  SentinelaSchema,
  type Selos,
  type Sentinela,
} from '../json';
import { SQL_ESTADOS_LATERAIS, SQL_EXECUCAO_ATIVA } from '../sql';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `execucao` (specs/forja/02 §4.6): a entidade-chave — 1 chamado × 1 tentativa.
 * Carrega o estado da máquina (03), os ponteiros para a worktree e para a
 * sessão condutora (F-02) e os números que a UI mostra sem varrer eventos.
 *
 * Invariantes no banco: I-1 (≤ 1 execução ativa por chamado), I-6 (worktree e
 * branch exclusivas entre ativas) por índices únicos parciais e I-9 (lateral
 * sabe para onde voltar) por CHECK. `motivo_texto` acompanha `motivo_estado`
 * (código da lista fechada) com o texto curto pt-BR que 02 §4.6 pede junto do
 * código — coluna própria para o código seguir validável por CHECK.
 */
export interface Execucao extends ComTempo {
  id: string;
  conexao_id: string;
  chamado_id: string;
  chamado_cache_id: string;
  projeto_id: string;
  lote_id: string | null;
  numero: number;
  tentativa: number;
  estado: EstadoExecucao;
  estado_anterior: EstadoExecucao | null;
  motivo_estado: MotivoEstado | null;
  motivo_texto: string | null;
  config_snapshot: ConfigResolvida;
  branch_destino: string;
  branch: string | null;
  worktree_dir: string | null;
  sha_base: string | null;
  sha_atual: string | null;
  sha_verificado: string | null;
  nivel_verificacao: NivelVerificacao | null;
  ciclo_auto: number;
  ciclo_total: number;
  session_id_planejador: string | null;
  session_id_condutor: string | null;
  aprovacao_vigente_id: string | null;
  sha_merge: string | null;
  selos: Selos | null;
  evidencia_visual: EvidenciaVisual | null;
  evidencia_visual_motivo: string | null;
  /** Obsoleto (FJ-031): não é mais escrito; a coluna fica por compatibilidade. */
  ia_silenciada_pelo_app: boolean;
  atribuido_pelo_app: boolean;
  sentinela: Sentinela | null;
  ultima_mensagem_ciente_id: string | null;
  custo_micro_usd: number;
  iniciado_em: string | null;
  concluido_em: string | null;
}

export const ExecucaoSchema = new EntitySchema<Execucao>({
  name: 'Execucao',
  tableName: 'execucao',
  columns: {
    id: pk(),
    conexao_id: texto(),
    chamado_id: texto(),
    chamado_cache_id: texto(),
    projeto_id: texto(),
    lote_id: texto(true),
    numero: inteiro(),
    tentativa: inteiro(),
    estado: texto(),
    estado_anterior: texto(true),
    motivo_estado: texto(true),
    motivo_texto: texto(true),
    config_snapshot: json(ConfigResolvidaSchema, 'execucao.config_snapshot'),
    branch_destino: texto(),
    branch: texto(true),
    worktree_dir: texto(true),
    sha_base: texto(true),
    sha_atual: texto(true),
    sha_verificado: texto(true),
    nivel_verificacao: texto(true),
    ciclo_auto: inteiro(),
    ciclo_total: inteiro(),
    session_id_planejador: texto(true),
    session_id_condutor: texto(true),
    aprovacao_vigente_id: texto(true),
    sha_merge: texto(true),
    selos: json(SelosSchema, 'execucao.selos', true),
    evidencia_visual: texto(true),
    evidencia_visual_motivo: texto(true),
    ia_silenciada_pelo_app: booleano(),
    atribuido_pelo_app: booleano(),
    sentinela: json(SentinelaSchema, 'execucao.sentinela', true),
    ultima_mensagem_ciente_id: texto(true),
    custo_micro_usd: inteiro(),
    iniciado_em: texto(true),
    concluido_em: texto(true),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_execucao_ativa_chamado',
      columns: ['conexao_id', 'chamado_id'],
      unique: true,
      where: SQL_EXECUCAO_ATIVA,
    },
    {
      name: 'ux_execucao_tentativa',
      columns: ['conexao_id', 'chamado_id', 'tentativa'],
      unique: true,
    },
    {
      name: 'ux_execucao_worktree_ativa',
      columns: ['worktree_dir'],
      unique: true,
      where: `${SQL_EXECUCAO_ATIVA} AND "worktree_dir" IS NOT NULL`,
    },
    {
      name: 'ux_execucao_branch_ativa',
      columns: ['projeto_id', 'branch'],
      unique: true,
      where: `${SQL_EXECUCAO_ATIVA} AND "branch" IS NOT NULL`,
    },
    { name: 'ix_execucao_estado', columns: ['estado'] },
    { name: 'ix_execucao_projeto_estado', columns: ['projeto_id', 'estado'] },
    { name: 'ix_execucao_lote', columns: ['lote_id'] },
  ],
  checks: [
    {
      name: 'ck_execucao_lateral_anterior',
      expression: `"estado" NOT IN (${SQL_ESTADOS_LATERAIS}) OR "estado_anterior" IS NOT NULL`,
    },
  ],
});
