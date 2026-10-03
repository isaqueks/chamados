import type { CustoTurno } from '../../comum/contratos';
import type { ClassificacaoProcesso, StatusCota } from '../../comum/estados';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import type { RateLimitInfo, ResultCli } from './stream';

/**
 * Telemetria por turno e cota da assinatura (specs/forja/01 §6.5; 04 §9;
 * 02 §4.7 `etapa.custo_micro_usd` e §4.14 `uso_assinatura`).
 *
 * POR QUE delta: pela doc do Agent SDK, `total_cost_usd` e `modelUsage` vêm
 * ACUMULADOS na sessão, inclusive o gasto restaurado num `--resume` (na CLI,
 * [NV → S5]; a fixture `b.jsonl` mostra o acumulado num mesmo processo:
 * 0,0135 → 0,0146 → 0,2024). O custo de um turno é o valor bruto menos o do
 * turno anterior da MESMA `session_id`. Se o S5 provar que o resume não
 * acumula, quem chama passa `acumulaNaSessao = false` e o delta vira o bruto.
 *
 * O custo é "equivalente a preço de tabela" (`costBasis: list`): não é a
 * cobrança da assinatura e a UI o exibe como tal. Valores monetários são
 * guardados em micro-USD inteiros (sem ponto flutuante no SQLite).
 */

export function microUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** O que o app extrai do último `result` (01 §6.5). */
export interface ResultadoFinal {
  subtype: string;
  is_error: boolean;
  terminal_reason: string | null;
  structured_output: unknown;
  total_cost_usd: number;
  usage: Record<string, unknown>;
  modelUsage: Record<string, Record<string, unknown>>;
  subagent_stats: unknown;
  num_turns: number;
  duration_ms: number;
  permission_denials: unknown[];
  result_index: number;
  texto: string | null;
}

export function extrairResultadoFinal(result: ResultCli): ResultadoFinal {
  return {
    subtype: result.subtype,
    is_error: result.is_error === true,
    terminal_reason: result.terminal_reason ?? null,
    structured_output: result.structured_output,
    total_cost_usd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0,
    usage: result.usage ?? {},
    modelUsage: result.modelUsage ?? {},
    subagent_stats: result.subagent_stats ?? null,
    num_turns: typeof result.num_turns === 'number' ? result.num_turns : 0,
    duration_ms: typeof result.duration_ms === 'number' ? result.duration_ms : 0,
    permission_denials: result.permission_denials ?? [],
    result_index: result.result_index ?? 0,
    texto: typeof result.result === 'string' ? result.result : null,
  };
}

/** Acumulado de uma sessão no fim de um turno (o que o app grava para calcular o próximo delta). */
export interface AcumuladoSessao {
  total_cost_usd: number;
  modelUsage: Record<string, Record<string, unknown>>;
}

/** Subtrai campo a campo os numéricos de `modelUsage`; o que não é número fica como no atual. */
export function deltaModelUsage(
  atual: Record<string, Record<string, unknown>>,
  anterior: Record<string, Record<string, unknown>> | null,
): Record<string, Record<string, unknown>> {
  const delta: Record<string, Record<string, unknown>> = {};
  for (const [modelo, campos] of Object.entries(atual)) {
    const antes = anterior?.[modelo] ?? {};
    const d: Record<string, unknown> = {};
    let mudou = false;
    for (const [campo, valor] of Object.entries(campos)) {
      const valorAntes = antes[campo];
      if (typeof valor === 'number' && typeof valorAntes === 'number') {
        d[campo] = valor - valorAntes;
        if (campo !== 'contextWindow' && campo !== 'maxOutputTokens' && d[campo] !== 0)
          mudou = true;
      } else {
        d[campo] = valor;
        if (typeof valor === 'number' && valor !== 0) mudou = true;
      }
    }
    // Um modelo que só aparece por estar acumulado de turnos anteriores não é "presente" neste turno.
    if (mudou || !anterior?.[modelo]) delta[modelo] = d;
  }
  return delta;
}

export function calcularCustoTurno(
  final: ResultadoFinal,
  anterior: AcumuladoSessao | null,
  acumulaNaSessao = true,
): CustoTurno {
  const base = acumulaNaSessao ? anterior : null;
  const custo = Math.max(0, final.total_cost_usd - (base?.total_cost_usd ?? 0));
  return {
    custo_usd: custo,
    model_usage_delta: deltaModelUsage(final.modelUsage, base?.modelUsage ?? null),
    subagent_stats: final.subagent_stats,
    num_turns: final.num_turns,
    duracao_ms: final.duration_ms,
    permission_denials: final.permission_denials,
  };
}

/** Modelos de `modelUsage` fora do perfil (04 §9: alerta vermelho "FORCE não segurou"). */
export function modelosInesperados(
  modelUsage: Record<string, Record<string, unknown>>,
  permitidos: readonly string[],
): string[] {
  return Object.keys(modelUsage).filter(
    (m) => !permitidos.some((p) => m === p || m.startsWith(`${p}-`) || m.startsWith(`${p}[`)),
  );
}

/** T1 com diff e sem Opus no delta: "o condutor fez tudo sozinho" (04 §9). */
export function condutorFezSozinho(
  diffNaoVazio: boolean,
  modelUsageDelta: Record<string, unknown>,
  modeloSubagentes: string,
): boolean {
  if (!diffNaoVazio) return false;
  return !Object.keys(modelUsageDelta).some(
    (m) => m === modeloSubagentes || m.startsWith(`${modeloSubagentes}-`),
  );
}

export function eventoTelemetriaTurno(
  ctx: { execucaoId: string | null; etapaId: string | null },
  final: ResultadoFinal,
  custo: CustoTurno,
  classificacao: ClassificacaoProcesso,
): NovoEventoForja {
  const custoMicro = microUsd(final.total_cost_usd);
  const deltaMicro = microUsd(custo.custo_usd);
  return {
    execucao_id: ctx.execucaoId,
    etapa_id: ctx.etapaId,
    tipo: 'telemetria.turno',
    nivel: 'info',
    resumo: `Turno: US$ ${custo.custo_usd.toFixed(4)} equivalente, ${final.num_turns} turnos, ${Math.round(final.duration_ms / 1000)} s`,
    dados: {
      custo_micro_usd: custoMicro,
      custo_delta_micro_usd: deltaMicro,
      num_turns: final.num_turns,
      duracao_ms: final.duration_ms,
      modelos: Object.keys(custo.model_usage_delta),
      classificacao,
    },
  };
}

// ---------------------------------------------------------------------------
// Cota (`rate_limit_event` → `uso_assinatura`)
// ---------------------------------------------------------------------------

/** Linha de `uso_assinatura` (02 §4.14), sem `id`/`etapa_id` (quem grava preenche). */
export interface SnapshotUso {
  utilizacao_5h: number | null;
  utilizacao_7d: number | null;
  reinicia_5h_em: string | null;
  reinicia_7d_em: string | null;
  status: StatusCota | null;
  status_overage: string | null;
  usando_creditos_extras: boolean | null;
  bruto: RateLimitInfo;
}

/** `resetsAt` vem em segundos desde a época. */
export function epocaParaIso(segundos: number | undefined): string | null {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos)) return null;
  return new Date(segundos * 1000).toISOString();
}

const STATUS_COTA = new Set<string>(['allowed', 'allowed_warning', 'rejected']);

export function snapshotUso(info: RateLimitInfo): SnapshotUso {
  const cinco = info.unifiedWindows?.five_hour;
  const sete = info.unifiedWindows?.seven_day;
  return {
    utilizacao_5h: typeof cinco?.utilization === 'number' ? cinco.utilization : null,
    utilizacao_7d: typeof sete?.utilization === 'number' ? sete.utilization : null,
    reinicia_5h_em: epocaParaIso(cinco?.resetsAt),
    reinicia_7d_em: epocaParaIso(sete?.resetsAt),
    status: info.status && STATUS_COTA.has(info.status) ? (info.status as StatusCota) : null,
    status_overage: info.overageStatus ?? null,
    usando_creditos_extras: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : null,
    bruto: info,
  };
}

/** `uso.atualizado` (global). `freioAtivo` é decisão do domínio (03 §7.6), não daqui. */
export function eventoUsoAtualizado(snapshot: SnapshotUso, freioAtivo: boolean): NovoEventoForja {
  const pct = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);
  return {
    execucao_id: null,
    etapa_id: null,
    tipo: 'uso.atualizado',
    nivel:
      snapshot.status === 'rejected'
        ? 'erro'
        : snapshot.status === 'allowed_warning'
          ? 'aviso'
          : 'info',
    resumo: `Cota da assinatura: 5 h ${pct(snapshot.utilizacao_5h)}, 7 dias ${pct(snapshot.utilizacao_7d)}`,
    dados: {
      utilizacao_5h: snapshot.utilizacao_5h,
      utilizacao_7d: snapshot.utilizacao_7d,
      reinicia_5h_em: snapshot.reinicia_5h_em,
      reinicia_7d_em: snapshot.reinicia_7d_em,
      status: snapshot.status,
      usando_creditos_extras: snapshot.usando_creditos_extras === true,
      freio_ativo: freioAtivo,
    },
  };
}

/** `resetsAt` de um `rate_limit_event` rejeitado (classificação `cota`, 01 §6.6). */
export function resetsAtRejeitado(info: RateLimitInfo): string | null {
  if (info.status !== 'rejected') return null;
  return epocaParaIso(info.resetsAt);
}
