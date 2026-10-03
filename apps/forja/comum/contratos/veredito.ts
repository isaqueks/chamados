import { z } from 'zod';
import { Caminho, IdCA, Sha, Texto } from './base';

/**
 * `veredito.v1` — saída do condutor no turno T2, consolidando os revisores Opus
 * (specs/forja/04 §5). Vale SÓ para o `sha_avaliado`, que precisa ser o
 * `sha_verificado` do app; o modelo nunca força avanço — a decisão é do código
 * (04 §6, 03 §2.4). Desde FJ-032 a revisão roda os checks do projeto e os
 * relata em `comandos_executados` (o app não executa comando nenhum).
 */

const Revisor = z.enum(['revisor_correcao', 'revisor_seguranca', 'testador_e2e']);

export const VereditoV1 = z.object({
  versao: z.literal(1),
  ciclo: z.number().int().min(1),
  /** Eco do SHA recebido no prompt. */
  sha_avaliado: Sha,
  revisores: z.array(Revisor).min(1),
  /** `bloqueado` = não dá para avaliar (ambiente). */
  decisao: z.enum(['aprovado', 'reprovado', 'bloqueado']),
  recomendacao: z.enum(['seguir', 'retrabalhar', 'escalar']),
  motivo_recomendacao: Texto(400),
  achados: z.array(
    z.object({
      id: z.string().regex(/^A\d{1,3}$/),
      revisor: Revisor,
      severidade: z.enum(['bloqueante', 'importante', 'sugestao']),
      categoria: z.enum([
        'correcao',
        'seguranca',
        'escopo',
        'teste',
        'regra_negocio',
        'schema',
        'desempenho',
        'manutencao',
      ]),
      arquivo: Caminho,
      linha: z.number().int().positive().nullable(),
      descricao: Texto(600),
      sugestao: Texto(600),
    }),
  ),
  criterios: z.array(
    z.object({
      id: IdCA,
      status: z.enum(['atendido', 'nao_atendido', 'nao_verificavel']),
      evidencia: Texto(400),
      evidencia_ref: z.string().nullable(),
    }),
  ),
  falhas_de_verificacao: z.array(
    z.object({
      comando: Texto(200),
      classificacao: z.enum(['codigo', 'teste', 'ambiente', 'instavel']),
      explicacao: Texto(400),
    }),
  ),
  fora_do_plano: z.array(
    z.object({ arquivo: Caminho, justificativa_aceitavel: z.boolean(), comentario: Texto(300) }),
  ),
  alteracoes_sensiveis: z.array(Texto(200)),
  /**
   * Comandos que a revisão RODOU (o condutor T2 ou os revisores), com exit code
   * (FJ-032). Obrigatório, pode ser vazio. O app cruza com os `tool_result` de
   * Bash do stream para calcular o nível ⚙ — relatado e não visto vira `declarado`.
   */
  comandos_executados: z.array(
    z.object({
      comando: Texto(300),
      exit_code: z.number().int().nullable(),
      resumo: z.string().max(400),
    }),
  ),
  /** Vai literal ao T1 seguinte. */
  instrucoes_para_retrabalho: z.string().max(3000),
});
export type VereditoV1 = z.infer<typeof VereditoV1>;
