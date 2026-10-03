import { z } from 'zod';
import { PlanoV1 } from './plano';
import { RelatorioV1 } from './relatorio';
import { RespostaV1 } from './resposta';
import { ResumoImplV1 } from './resumo-impl';
import { VereditoV1 } from './veredito';

/**
 * Contratos de saída estruturada dos agentes (specs/forja/04 §5, 00 §7.7).
 * `CONTRATOS` é o registro por nome versionado (`etapa.contrato`,
 * `artefato.contrato`); `paraJsonSchema` produz o `--json-schema` do turno.
 *
 * [NV compat M2] o dialeto aceito pela CLI (`$schema` 2020-12, `minItems`,
 * `pattern`). Plano B da spec: `target: 'draft-7'`, e as restrições ficam só no
 * `safeParse` do app — por isso o alvo é parâmetro, não constante.
 */

export * from './base';
export * from './plano';
export * from './resumo-impl';
export * from './veredito';
export * from './resposta';
export * from './relatorio';
export * from './registrados';

export const CONTRATOS = {
  'plano.v1': PlanoV1,
  'resumo_impl.v1': ResumoImplV1,
  'veredito.v1': VereditoV1,
  'relatorio.v1': RelatorioV1,
  'resposta.v1': RespostaV1,
} as const;
export type NomeContrato = keyof typeof CONTRATOS;
export type SaidaContrato<N extends NomeContrato> = z.infer<(typeof CONTRATOS)[N]>;

export type AlvoJsonSchema = 'draft-2020-12' | 'draft-7';

/**
 * JSON Schema de um contrato (pelo nome ou pelo schema zod) para `--json-schema`.
 *
 * Default `draft-7` e SEM `$schema`: o validador da CLI 2.1.288 rejeita o
 * documento inteiro quando encontra `$schema` do draft 2020-12 ("no schema with
 * key or ref https://json-schema.org/draft/2020-12/schema") — incidente real de
 * 2026-10-03, em que todo planejador falhava antes do primeiro turno. O zod
 * emite `$schema` em qualquer alvo, então a chave é sempre removida.
 */
export function paraJsonSchema(
  contrato: NomeContrato | z.ZodType,
  opcoes: { alvo?: AlvoJsonSchema } = {},
): Record<string, unknown> {
  const schema = typeof contrato === 'string' ? CONTRATOS[contrato] : contrato;
  const gerado = z.toJSONSchema(schema, { target: opcoes.alvo ?? 'draft-7' }) as Record<
    string,
    unknown
  >;
  const { $schema: _ignorado, ...semSchema } = gerado;
  return semSchema;
}

/** Revalida o `structured_output` no app (01 §6.5): a validação da CLI não basta. */
export function validarContrato<N extends NomeContrato>(
  nome: N,
  dado: unknown,
): z.ZodSafeParseResult<SaidaContrato<N>> {
  return CONTRATOS[nome].safeParse(dado) as z.ZodSafeParseResult<SaidaContrato<N>>;
}
