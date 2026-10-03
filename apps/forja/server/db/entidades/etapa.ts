import { EntitySchema } from 'typeorm';
import type { EstadoEtapa, MotivoFimEtapa, PapelAgente, TipoEtapa } from '../../../comum/estados';
import {
  ComandosEtapaSchema,
  JsonLivre,
  ObjetoJson,
  TelasEtapaSchema,
  type ComandosEtapa,
  type ObjetoJson as TObjetoJson,
  type JsonLivre as TJsonLivre,
  type TelasEtapa,
} from '../json';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `etapa` (specs/forja/02 §4.7): uma unidade de trabalho da execução — um
 * processo `claude` (planejar, T1/T2/T3, conversa) ou um bloco do próprio app
 * (`verificar`, `evidenciar`, `integrar`, sem `session_id` nem papel). O `n`
 * nomeia `etapas/<n>/` no diretório da execução.
 *
 * `session_id` é gerado ANTES do spawn (F-05) e `pid`/`pgid` gravados antes de
 * consumir o stream: é o que a reconciliação do boot usa para achar processo
 * órfão. I-2 (1 processo por sessão) = único parcial em `session_id` enquanto
 * `estado = 'executando'`; o cruzamento com `sessao_terminal` é do repositório.
 */
export interface Etapa extends ComTempo {
  id: string;
  execucao_id: string;
  n: number;
  ciclo: number;
  tipo: TipoEtapa;
  papel: PapelAgente | null;
  estado: EstadoEtapa;
  motivo_fim: MotivoFimEtapa | null;
  contrato: string | null;
  session_id: string | null;
  retomada: boolean;
  pid: number | null;
  pgid: number | null;
  modelo: string | null;
  esforco: string | null;
  prompt_versao: string | null;
  perfil: TObjetoJson | null;
  versao_cli: string | null;
  init: TObjetoJson | null;
  inicio: string;
  fim: string | null;
  ultimo_evento_em: string | null;
  exit_code: number | null;
  sinal: string | null;
  custo_micro_usd: number | null;
  model_usage: TJsonLivre | null;
  subagent_stats: TJsonLivre | null;
  permission_denials: TJsonLivre | null;
  condutor_editou: boolean;
  sha_inicio: string | null;
  sha_fim: string | null;
  comandos: ComandosEtapa | null;
  telas: TelasEtapa | null;
  transcript_path: string | null;
}

export const EtapaSchema = new EntitySchema<Etapa>({
  name: 'Etapa',
  tableName: 'etapa',
  columns: {
    id: pk(),
    execucao_id: texto(),
    n: inteiro(),
    ciclo: inteiro(),
    tipo: texto(),
    papel: texto(true),
    estado: texto(),
    motivo_fim: texto(true),
    contrato: texto(true),
    session_id: texto(true),
    retomada: booleano(),
    pid: inteiro(true),
    pgid: inteiro(true),
    modelo: texto(true),
    esforco: texto(true),
    prompt_versao: texto(true),
    perfil: json(ObjetoJson, 'etapa.perfil', true),
    versao_cli: texto(true),
    init: json(ObjetoJson, 'etapa.init', true),
    inicio: texto(),
    fim: texto(true),
    ultimo_evento_em: texto(true),
    exit_code: inteiro(true),
    sinal: texto(true),
    custo_micro_usd: inteiro(true),
    model_usage: json(JsonLivre, 'etapa.model_usage', true),
    subagent_stats: json(JsonLivre, 'etapa.subagent_stats', true),
    permission_denials: json(JsonLivre, 'etapa.permission_denials', true),
    condutor_editou: booleano(),
    sha_inicio: texto(true),
    sha_fim: texto(true),
    comandos: json(ComandosEtapaSchema, 'etapa.comandos', true),
    telas: json(TelasEtapaSchema, 'etapa.telas', true),
    transcript_path: texto(true),
    ...tempo(),
  },
  indices: [
    { name: 'ux_etapa_execucao_n', columns: ['execucao_id', 'n'], unique: true },
    {
      name: 'ux_etapa_sessao_executando',
      columns: ['session_id'],
      unique: true,
      where: `"estado" = 'executando' AND "session_id" IS NOT NULL`,
    },
    { name: 'ix_etapa_estado', columns: ['estado'] },
  ],
  checks: [
    {
      name: 'ck_etapa_do_app',
      expression: `"tipo" NOT IN ('verificar', 'evidenciar', 'integrar') OR ("papel" IS NULL AND "session_id" IS NULL)`,
    },
  ],
});
