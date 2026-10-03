import type { ConfigResolvidaDto, CotaDto } from '../../comum/dto';
import type { StatusCota, TipoEtapa } from '../../comum/estados';
import { ETAPAS_DE_AGENTE } from './lote';

/**
 * Freio de cota (specs/forja/03 §7.6; 02 §4.14; 06 §1.2).
 *
 * Fonte: o `rate_limit_event` mais recente de QUALQUER processo, já gravado
 * em `uso_assinatura` (o `snapshotUso` de server/claude/telemetria.ts tem a
 * mesma forma). O freio só impede INICIAR etapa de agente; as que estão
 * rodando continuam (DECISÃO PENDENTE de 03 §7.6, default: só bloquear e
 * alertar). Liberação = passou o `resetsAt` da janela que acionou: não espera
 * evento novo, porque sem processo rodando nenhum evento chega.
 */

/** Leitura de `uso_assinatura` (02 §4.14) — compatível com `SnapshotUso` + `criado_em`. */
export interface LeituraCota {
  utilizacao_5h: number | null;
  utilizacao_7d: number | null;
  /** ISO do `resetsAt` de cada janela. */
  reinicia_5h_em: string | null;
  reinicia_7d_em: string | null;
  status: StatusCota | null;
  usando_creditos_extras: boolean | null;
  /** `criado_em` da linha. */
  medido_em: string;
}

export type LimiaresCota = ConfigResolvidaDto['limites']['freio_cota'];

export const LIMIARES_PADRAO: LimiaresCota = {
  five_hour: 0.8,
  seven_day: 0.9,
  permitir_creditos_extras: false,
};

export type CausaFreio = 'five_hour' | 'seven_day' | 'overage';

export interface Freio {
  ativo: boolean;
  causas: CausaFreio[];
  /** Quando libera (ISO): o maior `resetsAt` entre as causas; null = desconhecido. */
  ate: string | null;
  /** Texto do banner (06 §1.3). */
  motivo: string | null;
}

const LIVRE: Freio = { ativo: false, causas: [], ate: null, motivo: null };

function passou(iso: string | null, agora: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && agora.getTime() >= t;
}

function maisTarde(isos: readonly (string | null)[]): string | null {
  const validos = isos.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  if (validos.length === 0) return null;
  return validos.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Freio = `five_hour ≥ 0,80` ∨ `seven_day ≥ 0,90` ∨ `isUsingOverage` sem
 * autorização (U-8). Uma janela cujo `resetsAt` já passou conta como zerada
 * (a leitura é anterior ao reset). O overage não traz janela própria: libera
 * no reset da janela esgotada (utilização ≥ 1) ou, sem essa informação, no
 * reset de 5 h; sem nenhum `resetsAt`, fica ativo até a próxima leitura.
 */
export function avaliarFreio(
  leitura: LeituraCota | null,
  limiares: LimiaresCota,
  agora: Date,
): Freio {
  if (!leitura) return LIVRE;
  const causas: CausaFreio[] = [];
  const resets: (string | null)[] = [];
  const cinco = !passou(leitura.reinicia_5h_em, agora) ? leitura.utilizacao_5h : null;
  const sete = !passou(leitura.reinicia_7d_em, agora) ? leitura.utilizacao_7d : null;
  if (cinco !== null && cinco >= limiares.five_hour) {
    causas.push('five_hour');
    resets.push(leitura.reinicia_5h_em);
  }
  if (sete !== null && sete >= limiares.seven_day) {
    causas.push('seven_day');
    resets.push(leitura.reinicia_7d_em);
  }
  if (leitura.usando_creditos_extras === true && !limiares.permitir_creditos_extras) {
    const esgotadas = [
      (leitura.utilizacao_5h ?? 0) >= 1 ? leitura.reinicia_5h_em : null,
      (leitura.utilizacao_7d ?? 0) >= 1 ? leitura.reinicia_7d_em : null,
    ].filter((x): x is string => x !== null);
    const ate = esgotadas.length > 0 ? maisTarde(esgotadas) : leitura.reinicia_5h_em;
    if (!passou(ate, agora)) {
      causas.push('overage');
      resets.push(ate);
    }
  }
  if (causas.length === 0) return LIVRE;
  const ate = resets.includes(null) ? null : maisTarde(resets);
  const porque = causas
    .map((c) =>
      c === 'five_hour'
        ? `5 h ≥ ${Math.round(limiares.five_hour * 100)}%`
        : c === 'seven_day'
          ? `7 dias ≥ ${Math.round(limiares.seven_day * 100)}%`
          : 'créditos extras em uso sem autorização',
    )
    .join(', ');
  return {
    ativo: true,
    causas,
    ate,
    motivo: ate
      ? `novas etapas pausadas até ${hhmm(ate)} (${porque})`
      : `novas etapas pausadas (${porque})`,
  };
}

export type BloqueioInicio =
  | { bloqueia: false; aviso: string | null }
  | { bloqueia: true; motivo: string; ate: string | null };

/**
 * O freio segura o INÍCIO de etapas de agente; verificação, prints e
 * integração seguem. A conversa (iniciada pelo humano) passa com aviso (03 §7.2).
 */
export function bloqueiaInicio(freio: Freio, etapa: TipoEtapa): BloqueioInicio {
  if (!freio.ativo || !ETAPAS_DE_AGENTE.includes(etapa)) return { bloqueia: false, aviso: null };
  if (etapa === 'conversar') return { bloqueia: false, aviso: freio.motivo };
  return { bloqueia: true, motivo: freio.motivo ?? 'freio de cota', ate: freio.ate };
}

/**
 * Overage não autorizado com etapas em curso: só alertar (default da
 * DECISÃO PENDENTE de 03 §7.6; interromper perderia trabalho em voo).
 */
export function acaoOverageEmCurso(
  leitura: LeituraCota | null,
  limiares: LimiaresCota,
): 'nenhuma' | 'alertar' {
  return leitura?.usando_creditos_extras === true && !limiares.permitir_creditos_extras
    ? 'alertar'
    : 'nenhuma';
}

// ---------------------------------------------------------------------------
// Limite batido no meio da etapa → `pausado_cota` (03 §7.6, §2.3)
// ---------------------------------------------------------------------------

export interface DecisaoPausaCota {
  /** Evento para `proximoEstado`. */
  evento: { tipo: 'limite_cota'; overage_nao_autorizado: boolean };
  /** `execucao.retoma_em` (ISO); null = desconhecido → espera a próxima leitura. */
  retoma_em: string | null;
}

/**
 * A etapa terminou com classificação `cota` (`result` de limite, `api_retry
 * rate_limit`, `status = rejected`): em `-p` ela FALHA em vez de pausar
 * [V 01 §8] → `pausado_cota` até o `resetsAt`.
 */
export function decidirPausaCota(entrada: {
  /** `resetsAtRejeitado(info)` do evento rejeitado, se houver. */
  resets_at_rejeitado: string | null;
  leitura: LeituraCota | null;
  limiares: LimiaresCota;
  agora: Date;
}): DecisaoPausaCota {
  const overage =
    entrada.leitura?.usando_creditos_extras === true && !entrada.limiares.permitir_creditos_extras;
  const freio = avaliarFreio(entrada.leitura, entrada.limiares, entrada.agora);
  return {
    evento: { tipo: 'limite_cota', overage_nao_autorizado: overage },
    retoma_em: entrada.resets_at_rejeitado ?? freio.ate ?? entrada.leitura?.reinicia_5h_em ?? null,
  };
}

/**
 * `pausado_cota` volta sozinho no `resetsAt` — e só se o freio não estiver
 * ativo por outra janela. A retomada segue 03 §3.3 mas NÃO conta como a
 * retomada automática de crash.
 */
export function podeRetomarPausaCota(retomaEm: string | null, freio: Freio, agora: Date): boolean {
  if (freio.ativo) return false;
  return retomaEm === null ? true : passou(retomaEm, agora);
}

// ---------------------------------------------------------------------------
// Termômetro do cabeçalho (06 §1.2)
// ---------------------------------------------------------------------------

export function montarCotaDto(
  leitura: LeituraCota | null,
  limiares: LimiaresCota,
  agora: Date,
): CotaDto {
  const freio = avaliarFreio(leitura, limiares, agora);
  return {
    utilizacao_5h: leitura?.utilizacao_5h ?? null,
    utilizacao_7d: leitura?.utilizacao_7d ?? null,
    reinicia_5h_em: leitura?.reinicia_5h_em ?? null,
    reinicia_7d_em: leitura?.reinicia_7d_em ?? null,
    medido_em: leitura?.medido_em ?? null,
    usando_creditos_extras: leitura?.usando_creditos_extras === true,
    limiar_5h: limiares.five_hour,
    limiar_7d: limiares.seven_day,
    freio: { ativo: freio.ativo, motivo: freio.motivo, ate: freio.ate },
  };
}
