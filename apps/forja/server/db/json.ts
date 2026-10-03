import type { ValueTransformer } from 'typeorm';
import { z } from 'zod';
import {
  AvancadoProjetoSchema,
  ConfigResolvidaSchema,
  ProjetoDetectadoSchema,
} from '../../comum/config-projeto';
import { Selos, ValidacaoResposta } from '../../comum/contratos';
import { MomentoEvidencia, ResultadoTela, valores } from '../../comum/estados';
import { ErroJsonInvalido } from './erros';

/**
 * Colunas JSON do SQLite (specs/forja/02 §1: `TEXT` + `CHECK json_valid`).
 *
 * POR QUE um transformer por coluna: a regra de 02 §1 é "leitura sempre passa
 * pelo zod — JSON inválido no banco = erro explícito, nunca default silencioso".
 * Pondo o zod no `ValueTransformer` da entidade, nenhum repositório consegue ler
 * a coluna sem validar, e a escrita serializa com `JSON.stringify` num só lugar.
 *
 * Colunas de telemetria crua (`init`, `model_usage`, `rate_limit_info`…) usam
 * `JsonLivre`: o formato é o da CLI, versionado por ela, e o app só exibe.
 */

/** Qualquer valor JSON (objeto, lista, escalar). */
export const JsonLivre = z.json();
export type JsonLivre = z.infer<typeof JsonLivre>;

/** Objeto JSON de chaves livres (perfil, init, model_usage…). */
export const ObjetoJson = z.record(z.string(), z.json());
export type ObjetoJson = z.infer<typeof ObjetoJson>;

export { Selos as SelosSchema };
export type { Selos };

/** `execucao.sentinela` (05 §4.9): hashes dos arquivos protegidos antes/depois da etapa. */
export const SentinelaSchema = z.object({
  antes: z.record(z.string(), z.string()),
  depois: z.record(z.string(), z.string()).nullable(),
  divergencias: z.array(z.string()),
  detectada_em: z.string().nullable(),
  reconhecida_em: z.string().nullable(),
});
export type Sentinela = z.infer<typeof SentinelaSchema>;

/** `chamado_cache.sinais` (02 §4.4): marcadores de `triagem-notas`, lidos do detalhe. */
export const SinaisCacheSchema = z.object({
  tem_spec_ia: z.boolean(),
  tem_diagnostico_ia: z.boolean(),
  tem_pr_ia: z.boolean(),
  branch_ia: z.string().nullable(),
});
export type SinaisCache = z.infer<typeof SinaisCacheSchema>;

export const SINAIS_VAZIOS: SinaisCache = {
  tem_spec_ia: false,
  tem_diagnostico_ia: false,
  tem_pr_ia: false,
  branch_ia: null,
};

/** `etapa.comandos` (verificar/integrar/evidenciar). */
export const ComandosEtapaSchema = z.array(
  z.object({
    nome: z.string(),
    exit_code: z.number().int().nullable(),
    duracao_ms: z.number().int().min(0),
    log_ref: z.string(),
    instavel: z.boolean(),
  }),
);
export type ComandosEtapa = z.infer<typeof ComandosEtapaSchema>;

/** `etapa.telas` (só `evidenciar`, FJ-026). */
export const TelasEtapaSchema = z.object({
  momento: z.enum(valores(MomentoEvidencia)),
  telas: z.array(
    z.object({
      tela_id: z.string(),
      rota: z.string(),
      resultado: z.enum(valores(ResultadoTela)),
      artefato_id: z.string().nullable(),
      duracao_ms: z.number().int().min(0),
    }),
  ),
});
export type TelasEtapa = z.infer<typeof TelasEtapaSchema>;

/** `aprovacao.validacao_resposta`: violações do validador + "publicar mesmo assim". */
export const ValidacaoAprovacaoSchema = ValidacaoResposta.extend({
  publicar_mesmo_assim: z.boolean(),
});
export type ValidacaoAprovacao = z.infer<typeof ValidacaoAprovacaoSchema>;

export const ListaCaminhosSchema = z.array(z.string());

export { AvancadoProjetoSchema, ConfigResolvidaSchema, ProjetoDetectadoSchema };

function ehOperadorTypeorm(v: unknown): boolean {
  // FindOperator/funções de SQL cru passam intactas (where/set do QueryBuilder).
  return typeof v === 'function' || (typeof v === 'object' && v !== null && '@instanceof' in v);
}

/** Lê o texto do banco e valida; serializa na escrita. `coluna` = `tabela.coluna` nas mensagens. */
export function transformadorJson(schema: z.ZodType, coluna: string): ValueTransformer {
  return {
    to(valor: unknown): unknown {
      if (valor === undefined || valor === null || ehOperadorTypeorm(valor)) return valor;
      const r = schema.safeParse(valor);
      if (!r.success) throw new ErroJsonInvalido(coluna, z.prettifyError(r.error));
      return JSON.stringify(r.data);
    },
    from(valor: unknown): unknown {
      if (valor === null || valor === undefined) return null;
      let bruto: unknown;
      try {
        bruto = typeof valor === 'string' ? JSON.parse(valor) : valor;
      } catch (e) {
        throw new ErroJsonInvalido(coluna, (e as Error).message);
      }
      const r = schema.safeParse(bruto);
      if (!r.success) throw new ErroJsonInvalido(coluna, z.prettifyError(r.error));
      return r.data;
    },
  };
}

/** Valida + serializa fora de entidade (SQL cru). */
export function serializarJson(schema: z.ZodType, valor: unknown, coluna: string): string {
  const r = schema.safeParse(valor);
  if (!r.success) throw new ErroJsonInvalido(coluna, z.prettifyError(r.error));
  return JSON.stringify(r.data);
}
