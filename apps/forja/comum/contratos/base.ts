import { z } from 'zod';
import { NivelVerificacao as NivelVerificacaoEnum } from '../estados';

/**
 * Peças comuns dos contratos (specs/forja/04 §5), transcritas LITERALMENTE da
 * spec. POR QUE zod: o mesmo schema vira o `--json-schema` do turno (via
 * `z.toJSONSchema`) e revalida o `structured_output` no app — a validação da
 * CLI não basta (01 §6.5). Refinamentos entre campos não cabem em JSON Schema e
 * ficam em código (04 §6), fora destes schemas.
 */

export const Texto = (max: number) => z.string().trim().min(1).max(max);

/** Relativo à raiz da worktree; o app normaliza e recusa absoluto e `..` (04 §6). */
export const Caminho = z.string().min(1).max(300);

export const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const IdCA = z.string().regex(/^CA\d{1,2}$/);
export const IdPasso = z.string().regex(/^P\d{1,2}$/);

export const TipoMudanca = z.enum([
  'tabela_nova',
  'coluna_nova',
  'coluna_alterada',
  'remocao',
  'indice',
  'dados',
]);

export const Area = z.enum([
  'schema_banco',
  'migration',
  'regra_negocio',
  'ui',
  'api',
  'autenticacao',
  'permissoes',
  'integracao',
  'config',
  'build',
]);

/** Mesmos valores de `NivelVerificacao` em `estados.ts` (fonte única). */
export const NivelVerificacaoSchema = z.enum(NivelVerificacaoEnum);

// ---------- telas afetadas (FJ-026; FJ-030 §3): DICA ao condutor, que fotografa sozinho ----------

export const IdTela = z.string().regex(/^UI\d{1,2}$/);

/** Relativa à raiz do app; sem host, sem `..`. */
export const Rota = z
  .string()
  .regex(/^\/[^\s]*$/)
  .max(300);

/**
 * Tela que a mudança afeta. Desde FJ-030 §3 quem sobe o app e fotografa é o
 * condutor (bloco B7), então não há mais DSL de passos: `rota` + `descricao` +
 * `estado_esperado` bastam como dica (como chegar ao estado é com ele).
 */
export const TelaAfetada = z.object({
  id: IdTela,
  /** "Cadastro de cliente com e-mail repetido". */
  descricao: Texto(200),
  rota: Rota,
  /** O que quem usa deve ver depois da mudança. */
  estado_esperado: Texto(300),
});
export type TelaAfetada = z.infer<typeof TelaAfetada>;
