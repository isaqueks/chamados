/**
 * Configuração de MODELO, ESFORÇO e TIMEOUT da IA (D-031, D-044).
 *
 * Fonte ÚNICA das listas e limites usados por:
 *  - worker (`apps/worker`): defaults do `.env` (`IA_MODELO`/`IA_ESFORCO`/
 *    `IA_TIMEOUT_MS`) e resolução do override por tenant;
 *  - web (`/app/config`, card "Assistente IA"): select de modelo/esforço e
 *    validação do timeout;
 *  - db (`tenants/config-service.ts`): validação na fronteira de gravação.
 *
 * Funções PURAS, sem dependência de runtime (o `env` é passado por parâmetro).
 */

// ---------------------------------------------------------------------------
// Esforço de raciocínio (D-031)
// ---------------------------------------------------------------------------

/** Níveis de esforço aceitos pelo Agent SDK (`options.effort`), do menor ao maior. */
export const ESFORCOS_IA = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Nível de esforço de raciocínio do modelo (D-031). Mapeia 1:1 no `options.effort`
 * do Agent SDK; níveis acima do que o modelo suporta caem para o mais alto que ele
 * tenha (o SDK rebaixa em silêncio).
 */
export type EsforcoIA = (typeof ESFORCOS_IA)[number];

/** Esforço default da triagem (D-031): raciocínio profundo, sem entrar no xhigh. */
export const ESFORCO_IA_PADRAO: EsforcoIA = 'high';

/** Rótulos pt-BR dos níveis (UI de config). */
export const ROTULO_ESFORCO_IA: Record<EsforcoIA, string> = {
  low: 'Baixo (low)',
  medium: 'Médio (medium)',
  high: 'Alto (high)',
  xhigh: 'Muito alto (xhigh)',
  max: 'Máximo (max)',
};

/** Normaliza (trim + minúsculas) e valida um esforço; inválido/ausente → `null`. */
export function normalizarEsforcoIa(v: unknown): EsforcoIA | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  return (ESFORCOS_IA as readonly string[]).includes(n) ? (n as EsforcoIA) : null;
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

/** Modelo default do provider real (D-031). */
export const MODELO_IA_PADRAO = 'claude-opus-5';

/** Teto de caracteres de um ID de modelo digitado livremente (D-044). */
export const LIMITE_IA_MODELO_CHARS = 64;

/**
 * Modelos SUGERIDOS no select da UI (D-044). Não é allowlist: o admin pode
 * digitar outro ID (modelos novos surgem) — validado só pelo formato.
 */
export const MODELOS_IA_SUGERIDOS: ReadonlyArray<{ id: string; rotulo: string }> = [
  { id: MODELO_IA_PADRAO, rotulo: 'Claude Opus 5' },
  { id: 'claude-opus-5-5', rotulo: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-2', rotulo: 'Claude Fable 5.2' },
  { id: 'claude-sonnet-5-5', rotulo: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', rotulo: 'Claude Haiku 5.5' },
];

/** Formato de ID de modelo: começa por letra/dígito; só `[a-z0-9.-]`. */
const RE_MODELO = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * Normaliza (trim + minúsculas) e valida um ID de modelo; inválido/ausente →
 * `null`. Charset restrito a `[a-z0-9.-]` e até `LIMITE_IA_MODELO_CHARS` — o
 * valor vai parar no `options.model` do SDK e em logs/auditoria.
 */
export function normalizarModeloIa(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  if (n.length === 0 || n.length > LIMITE_IA_MODELO_CHARS) return null;
  return RE_MODELO.test(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Timeout da triagem e seu TETO (D-044)
// ---------------------------------------------------------------------------

/** Timeout default por execução de triagem (`IA_TIMEOUT_MS`). */
export const IA_TIMEOUT_PADRAO_MS = 600_000;

/** Timeout default do mapeamento de sistema (`IA_MAPA_TIMEOUT_MS`, D-013). */
export const IA_MAPA_TIMEOUT_PADRAO_MS = 600_000;

/**
 * Janela do turno de CONCLUSÃO do mapeamento (D-033): após o corte da exploração,
 * o provider retoma a sessão por até este tempo para escrever o resumo.
 */
export const IA_MAPA_TIMEOUT_CONCLUSAO_MS = 180_000;

/**
 * Limiar da varredura de execuções ÓRFÃS (`MANUTENCAO_EXECUCAO_ORFA_MS`, D-016):
 * `ExecucaoIA` em `na_fila`/`executando` além disso vira `falhou`
 * (`execucao_orfa`) e o chamado é escalado.
 */
export const IA_EXECUCAO_ORFA_PADRAO_MS = 1_800_000;

/**
 * Folga reservada, dentro do limiar de órfã, para o que a triagem faz FORA da
 * chamada ao provider: git clone/pull, Tx1/Tx2, download de imagens, branch/push/PR.
 */
export const IA_FOLGA_EXECUCAO_TRIAGEM_MS = 120_000;

/** Timeout mínimo configurável por tenant (1 min). */
export const IA_TIMEOUT_TENANT_MIN_MS = 60_000;

/**
 * TETO do timeout da triagem configurável por tenant (D-044), DERIVADO da config.
 *
 * A `ExecucaoIA` da triagem fica `executando` desde a Tx1 — antes do git sync e
 * do mapeamento INLINE da primeira geração (D-033), que roda dentro da mesma
 * janela. A varredura de órfãs (D-016) não sabe que a execução está viva: se a
 * soma passar do limiar, uma triagem legítima é marcada `execucao_orfa` e o
 * chamado é escalado no meio da análise. Então:
 *
 *   teto = limiar_órfã − timeout_mapa − conclusão_mapa − folga
 *        = 30 − 10 − 3 − 2 = 15 min (com os defaults)
 *
 * O lock por tenant NÃO impõe teto: é renovado por heartbeat enquanto o processo
 * vive (D-016). Nunca devolve menos que o mínimo configurável.
 */
export function calcularTetoTimeoutTriagemMs(cfg: {
  execucaoOrfaMs: number;
  mapaTimeoutMs: number;
}): number {
  const teto =
    cfg.execucaoOrfaMs -
    cfg.mapaTimeoutMs -
    IA_MAPA_TIMEOUT_CONCLUSAO_MS -
    IA_FOLGA_EXECUCAO_TRIAGEM_MS;
  return Math.max(IA_TIMEOUT_TENANT_MIN_MS, teto);
}

/** Teto com os defaults da instalação (15 min) — referência de UI/testes. */
export const IA_TIMEOUT_TENANT_MAX_MS = calcularTetoTimeoutTriagemMs({
  execucaoOrfaMs: IA_EXECUCAO_ORFA_PADRAO_MS,
  mapaTimeoutMs: IA_MAPA_TIMEOUT_PADRAO_MS,
});

// ---------------------------------------------------------------------------
// Defaults da instalação lidos do ambiente (worker e web leem o MESMO `.env`)
// ---------------------------------------------------------------------------

export interface PadroesIaAmbiente {
  /** `IA_MODELO` (vazio/ausente → `MODELO_IA_PADRAO`). */
  modelo: string;
  /** `IA_ESFORCO` (inválido → `ESFORCO_IA_PADRAO`, sem derrubar o worker — D-031). */
  esforco: EsforcoIA;
  /** `IA_TIMEOUT_MS` (não positivo/ausente → `IA_TIMEOUT_PADRAO_MS`). */
  timeoutMs: number;
  /** `IA_MAPA_TIMEOUT_MS`. */
  mapaTimeoutMs: number;
  /** `MANUTENCAO_EXECUCAO_ORFA_MS`. */
  execucaoOrfaMs: number;
  /** Teto do timeout por tenant derivado dos dois acima. */
  tetoTimeoutTenantMs: number;
}

function numPositivo(v: string | undefined, padrao: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

/**
 * Lê os defaults de IA do ambiente. Mesma semântica do `config.ts` do worker:
 * valor ausente/inválido cai no default em vez de lançar.
 */
export function lerPadroesIaAmbiente(env: Record<string, string | undefined>): PadroesIaAmbiente {
  const mapaTimeoutMs = numPositivo(env.IA_MAPA_TIMEOUT_MS, IA_MAPA_TIMEOUT_PADRAO_MS);
  const execucaoOrfaMs = numPositivo(env.MANUTENCAO_EXECUCAO_ORFA_MS, IA_EXECUCAO_ORFA_PADRAO_MS);
  return {
    modelo: env.IA_MODELO?.trim() || MODELO_IA_PADRAO,
    esforco: normalizarEsforcoIa(env.IA_ESFORCO) ?? ESFORCO_IA_PADRAO,
    timeoutMs: numPositivo(env.IA_TIMEOUT_MS, IA_TIMEOUT_PADRAO_MS),
    mapaTimeoutMs,
    execucaoOrfaMs,
    tetoTimeoutTenantMs: calcularTetoTimeoutTriagemMs({ execucaoOrfaMs, mapaTimeoutMs }),
  };
}

// ---------------------------------------------------------------------------
// Validação da config por tenant (fronteira de gravação — D-044)
// ---------------------------------------------------------------------------

/** Valores persistidos em `tenant` (`null` = "Padrão da instalação"). */
export interface ConfigModeloIaTenant {
  ia_modelo: string | null;
  ia_esforco: EsforcoIA | null;
  ia_timeout_ms: number | null;
}

/** Entrada bruta (formulário/API). Vazio/`null`/ausente = usar o padrão. */
export interface EntradaConfigModeloIa {
  modelo?: string | null;
  esforco?: string | null;
  timeoutMs?: number | null;
}

export type ResultadoValidacaoModeloIa =
  { ok: true; valor: ConfigModeloIaTenant } | { ok: false; erro: string };

const vazio = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Valida a config de modelo/esforço/timeout do tenant. Mensagens em pt-BR prontas
 * para o formulário. `tetoTimeoutMs` vem do ambiente (`lerPadroesIaAmbiente`).
 */
export function validarConfigModeloIa(
  entrada: EntradaConfigModeloIa,
  tetoTimeoutMs: number = IA_TIMEOUT_TENANT_MAX_MS,
): ResultadoValidacaoModeloIa {
  let ia_modelo: string | null = null;
  if (!vazio(entrada.modelo)) {
    ia_modelo = normalizarModeloIa(entrada.modelo);
    if (!ia_modelo) {
      return {
        ok: false,
        erro: `Modelo inválido. Use só letras minúsculas, números, ponto e hífen (até ${LIMITE_IA_MODELO_CHARS} caracteres), ex.: ${MODELO_IA_PADRAO}.`,
      };
    }
  }

  let ia_esforco: EsforcoIA | null = null;
  if (!vazio(entrada.esforco)) {
    ia_esforco = normalizarEsforcoIa(entrada.esforco);
    if (!ia_esforco) {
      return { ok: false, erro: `Esforço inválido. Use um destes: ${ESFORCOS_IA.join(', ')}.` };
    }
  }

  let ia_timeout_ms: number | null = null;
  if (!vazio(entrada.timeoutMs)) {
    const t = Number(entrada.timeoutMs);
    const teto = Math.max(IA_TIMEOUT_TENANT_MIN_MS, tetoTimeoutMs);
    if (!Number.isInteger(t) || t < IA_TIMEOUT_TENANT_MIN_MS || t > teto) {
      return {
        ok: false,
        erro: `O tempo limite deve estar entre ${formatarMinutos(IA_TIMEOUT_TENANT_MIN_MS)} e ${formatarMinutos(teto)}.`,
      };
    }
    ia_timeout_ms = t;
  }

  return { ok: true, valor: { ia_modelo, ia_esforco, ia_timeout_ms } };
}

/** "1 minuto" / "15 minutos" / "1,5 minuto" (pt-BR). */
export function formatarMinutos(ms: number): string {
  const min = ms / 60_000;
  const texto = Number.isInteger(min)
    ? String(min)
    : min.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return `${texto} ${min < 2 ? 'minuto' : 'minutos'}`;
}
