import { z } from 'zod';
import { EvidenciaVisual } from '../estados';
import { NivelVerificacaoSchema, Sha } from './base';
import { PlanoV1 } from './plano';
import { RelatorioV1, AlteracoesInterfaceV1, TelaInterfaceV1 } from './relatorio';
import { RespostaV1 } from './resposta';
import { ResumoImplV1 } from './resumo-impl';
import { VereditoV1 } from './veredito';

/**
 * Versões ⚙ "registradas" dos contratos (specs/forja/04 §5, comentários `⚙`):
 * o contrato do modelo + os campos que SÓ o app calcula. São estas as formas
 * gravadas em `artefato.conteudo` (02 §4.9) e servidas à UI. POR QUE separar:
 * o schema enviado à CLI (`--json-schema`) é o do modelo — o agente nunca
 * escreve selo, nível de verificação, sha ou patch-id (F-12).
 */

/** Telemetria de um turno (04 §9). `custo_usd` é "equivalente a preço de API", não cobrança. */
export const CustoTurno = z.object({
  custo_usd: z.number().nonnegative(),
  model_usage_delta: z.record(z.string(), z.unknown()),
  subagent_stats: z.unknown(),
  num_turns: z.number().int().nonnegative(),
  duracao_ms: z.number().int().nonnegative(),
  permission_denials: z.array(z.unknown()),
});
export type CustoTurno = z.infer<typeof CustoTurno>;

/** Selos ⚙ calculados pelo app a partir dos globs do projeto (04 §7.1, 02 §4.6). */
export const Selos = z.object({
  altera_banco: z.boolean(),
  altera_regra_negocio: z.boolean(),
  altera_ui: z.boolean(),
  sensivel: z.array(z.string()),
  /** null = o projeto não declara `docs_exigidas`. */
  docs_exigidas_ok: z.boolean().nullable(),
});
export type Selos = z.infer<typeof Selos>;

export const PlanoRegistrado = PlanoV1.extend({
  sha_base: Sha,
  gate_g1: z.object({ exigido: z.boolean(), motivos: z.array(z.string()) }),
  /** ⚙ FJ-034: riscos que não pararam no G1 (sinais, confiança, schema…), até a Aprovação. */
  avisos: z.array(z.string()).default([]),
  editado_pelo_operador: z.boolean(),
  prompt_versao: z.string(),
  custo_turno: CustoTurno,
});
export type PlanoRegistrado = z.infer<typeof PlanoRegistrado>;

/** Comando Bash visto no stream de um turno (FJ-032). */
export const ComandoDoStream = z.object({
  comando: z.string(),
  resultado: z.enum(['exit_0', 'erro', 'sem_resultado']),
});
export type ComandoDoStream = z.infer<typeof ComandoDoStream>;

export const ResumoImplRegistrado = ResumoImplV1.extend({
  sha_checkpoints: z.array(Sha),
  sha_final: Sha,
  arquivos_reais: z.array(z.string()),
  diff_stat: z.object({ arquivos: z.number(), adicoes: z.number(), remocoes: z.number() }),
  condutor_editou: z.array(
    z.object({ ferramenta: z.enum(['Edit', 'Write', 'Bash']), alvo: z.string() }),
  ),
  subagentes: z.array(z.object({ tipo: z.string(), modelo: z.string(), chamadas: z.number() })),
  custo_turno: CustoTurno,
  /**
   * Comandos de verificação/instalação que o T1 e os implementadores rodaram,
   * lidos do stream (FJ-032). Informativo: vai ao T2 e à aba do relatório.
   * Ausente em artefatos anteriores a FJ-032.
   */
  comandos_stream: z.array(ComandoDoStream).optional(),
  /**
   * Conflitos com o destino resolvidos pelo agente na fila de merge (FJ-036),
   * do mais antigo ao mais novo. Cada resolução gera uma versão nova deste
   * artefato (o resumo do T1 original fica). Ausente antes de FJ-036.
   */
  resolucoes_conflito: z
    .array(
      z.object({
        destino: z.string(),
        sha_destino: Sha,
        /** Commit de merge do app que concluiu a resolução. */
        sha: Sha,
        arquivos: z.array(z.string()),
        resumo_tecnico: z.string(),
      }),
    )
    .optional(),
});
export type ResumoImplRegistrado = z.infer<typeof ResumoImplRegistrado>;

/**
 * Um comando relatado pela revisão (`veredito.v1.comandos_executados`) e o que
 * o app viu no stream do T2 (FJ-032): `exit_0` = `tool_result` de Bash sem
 * erro, `erro` = com erro, `nao_visto` = relatado mas ausente do stream.
 */
export const ComandoVerificado = z.object({
  comando: z.string(),
  exit_code: z.number().int().nullable(),
  resumo: z.string(),
  no_stream: z.enum(['exit_0', 'erro', 'nao_visto']),
});
export type ComandoVerificado = z.infer<typeof ComandoVerificado>;

export const VereditoRegistrado = VereditoV1.extend({
  verificacao: z.object({
    nivel: NivelVerificacaoSchema,
    /** Por que o nível não subiu mais (FJ-032). Ausente em artefatos antigos. */
    motivo: z.string().optional(),
    sha_verificado: Sha,
    comandos: z.array(ComandoVerificado),
  }),
  valido: z.boolean(),
  motivo_invalido: z.string().optional(),
  /** Ids em pingue-pongue (03 §6). */
  repetidos: z.array(z.string()),
  decisao_do_app: z.enum(['relatando', 'retrabalho', 'precisa_humano']),
  custo_turno: CustoTurno,
});
export type VereditoRegistrado = z.infer<typeof VereditoRegistrado>;

export const ValidacaoResposta = z.object({
  tecnico: z.array(z.string()),
  promessa: z.array(z.string()),
  lexico: z.array(z.string()),
  disponibilidade: z.array(z.string()),
  ok: z.boolean(),
});
export type ValidacaoResposta = z.infer<typeof ValidacaoResposta>;

export const RespostaRegistrada = RespostaV1.extend({
  validacao: ValidacaoResposta,
  publicar_mesmo_assim: z.object({ em: z.string(), motivos: z.array(z.string()) }).nullable(),
  editada_pelo_operador: z.boolean(),
  corpo_hash: z.string(),
});
export type RespostaRegistrada = z.infer<typeof RespostaRegistrada>;

export const TelaInterfaceRegistrada = TelaInterfaceV1.extend({
  /** `artefato:<id>`; null = tela nova (não existia antes). */
  antes_ref: z.string().nullable(),
  depois_ref: z.string().nullable(),
  rota: z.string(),
});

export const RelatorioRegistrado = RelatorioV1.extend({
  alteracoes_de_interface: AlteracoesInterfaceV1.extend({
    telas: z.array(TelaInterfaceRegistrada),
  }),
  selos: Selos,
  nivel_verificacao: NivelVerificacaoSchema,
  ciclos: z.number().int(),
  custo_equivalente_usd: z.number(),
  arquivos: z.number().int(),
  linhas: z.object({ adicoes: z.number().int(), remocoes: z.number().int() }),
  sha: Sha,
  patch_id: z.string(),
  sensiveis: z.array(z.string()),
  achados_em_aberto: z.array(z.string()),
  condutor_editou: z.boolean(),
  incoerencias: z.array(z.string()),
  regenerado: z.boolean(),
  evidencia_visual: z.enum(EvidenciaVisual),
  evidencia_visual_motivo: z.string().nullable(),
});
export type RelatorioRegistrado = z.infer<typeof RelatorioRegistrado>;
