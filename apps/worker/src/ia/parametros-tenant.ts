import {
  IA_TIMEOUT_TENANT_MIN_MS,
  normalizarEsforcoIa,
  normalizarModeloIa,
  type AIProvider,
  type ParametrosModelo,
} from '@chamados/shared';

/**
 * Resolução da config de IA do TENANT (D-044) para uma execução.
 *
 * Precedência: **tenant > env > default do código**. Este módulo decide só o
 * primeiro degrau — o segundo e o terceiro já estão no default do provider
 * (`iaConfig.modelo/esforco` = `IA_MODELO`/`IA_ESFORCO` → `MODELO_IA_PADRAO`/
 * `ESFORCO_IA_PADRAO`) e no `iaConfig.limites.timeoutMs` (`IA_TIMEOUT_MS`).
 *
 * Valor inválido no banco NUNCA derruba o worker (mesma filosofia de D-031):
 * vira ausente — cai no padrão da instalação — e é devolvido em `descartados`
 * para o chamador logar. Timeout acima do teto (ex.: o operador baixou
 * `MANUTENCAO_EXECUCAO_ORFA_MS` depois de o admin salvar) é REBAIXADO ao teto.
 */

/** Colunas de `tenant` relevantes (aceita a entidade inteira ou `null`). */
export interface ConfigIaTenantBruta {
  ia_modelo?: string | null;
  ia_esforco?: string | null;
  ia_timeout_ms?: number | null;
}

export interface ParametrosIaResolvidos {
  /** Override de modelo/esforço para o provider (campos ausentes = default do provider). */
  parametrosModelo: ParametrosModelo;
  /** Timeout EFETIVO da triagem (o mapeamento tem limites próprios e não usa). */
  timeoutMs: number;
  /** Campos do tenant com valor inválido, ignorados (para log). */
  descartados: Array<'ia_modelo' | 'ia_esforco' | 'ia_timeout_ms'>;
  /** `true` quando o timeout do tenant passou do teto e foi rebaixado. */
  timeoutRebaixado: boolean;
}

/**
 * Só modelo/esforço (D-044) — usado pelo MAPEAMENTO (que tem limites próprios)
 * e pela compensação de falha final da fila.
 */
export function resolverParametrosModeloTenant(
  tenant: ConfigIaTenantBruta | null | undefined,
): Pick<ParametrosIaResolvidos, 'parametrosModelo' | 'descartados'> {
  const parametrosModelo: ParametrosModelo = {};
  const descartados: ParametrosIaResolvidos['descartados'] = [];

  if (tenant?.ia_modelo != null) {
    const m = normalizarModeloIa(tenant.ia_modelo);
    if (m) parametrosModelo.modelo = m;
    else descartados.push('ia_modelo');
  }

  if (tenant?.ia_esforco != null) {
    const e = normalizarEsforcoIa(tenant.ia_esforco);
    if (e) parametrosModelo.esforco = e;
    else descartados.push('ia_esforco');
  }

  return { parametrosModelo, descartados };
}

/** Modelo/esforço + timeout EFETIVO da triagem (D-044). */
export function resolverParametrosIaTenant(
  tenant: ConfigIaTenantBruta | null | undefined,
  padrao: { timeoutMs: number; tetoTimeoutMs: number },
): ParametrosIaResolvidos {
  const { parametrosModelo, descartados } = resolverParametrosModeloTenant(tenant);

  let timeoutMs = padrao.timeoutMs;
  let timeoutRebaixado = false;
  if (tenant?.ia_timeout_ms != null) {
    const t = Number(tenant.ia_timeout_ms);
    if (Number.isInteger(t) && t >= IA_TIMEOUT_TENANT_MIN_MS) {
      const teto = Math.max(IA_TIMEOUT_TENANT_MIN_MS, padrao.tetoTimeoutMs);
      timeoutRebaixado = t > teto;
      timeoutMs = Math.min(t, teto);
    } else {
      descartados.push('ia_timeout_ms');
    }
  }

  return { parametrosModelo, timeoutMs, descartados, timeoutRebaixado };
}

/**
 * Modelo EFETIVO de uma execução (D-044) — o que vai para `ExecucaoIA.modelo` e
 * para o evento `ia_iniciou`. Provider que não aceita override (fake) não
 * implementa `modeloEfetivo` e fica com o próprio `modelo`.
 */
export function modeloEfetivoDe(provider: AIProvider, parametros?: ParametrosModelo): string {
  return provider.modeloEfetivo?.(parametros) ?? provider.modelo;
}
