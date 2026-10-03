import type { ComandoDoStream, ComandoVerificado } from '../../comum/contratos';
import type { EvidenciaVisual, NivelVerificacao, ResultadoTela } from '../../comum/estados';

/**
 * Níveis ⚙ calculados pelo app (specs/forja/03 §5.3 e §5.4; FJ-026, FJ-032).
 *
 * Desde FJ-032 a Forja NÃO executa comandos do projeto: quem roda os checks é o
 * agente. O app só REGISTRA, cruzando o que a revisão relatou
 * (`veredito.v1.comandos_executados`) com os `tool_result` de Bash do stream do
 * T2 (thread principal e subagentes):
 *
 * - `verificado_pelo_revisor`: há comando relatado e TODOS aparecem no stream
 *   com exit 0 (e foram relatados com exit 0);
 * - `declarado`: há comando relatado, mas algum não aparece no stream, diverge
 *   dele ou ficou vermelho;
 * - `nao_verificado`: nada relatado.
 *
 * NUNCA arredondado para cima, e não bloqueia o G2: é informação para o humano.
 * Evidência visual é um eixo SEPARADO (prints não são teste): nunca eleva o nível.
 */

export type NivelAtual = Extract<
  NivelVerificacao,
  'verificado_pelo_revisor' | 'declarado' | 'nao_verificado'
>;

export interface CalculoNivel {
  nivel: NivelAtual;
  /** Por que não subiu mais (para o relatório e a UI). */
  motivo: string;
  /** Cada comando relatado com o que o stream mostrou. */
  comandos: ComandoVerificado[];
}

/** Espaços colapsados, sem a marca de truncado do feed nem `2>&1`/`| tail` de cauda. */
export function normalizarComando(comando: string): string {
  return comando
    .replace(/…$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*2>&1\b/g, '')
    .replace(/\s*\|\s*(tail|head)\b.*$/, '')
    .trim();
}

/**
 * O comando relatado é o do stream? Igual, ou um contém o outro (o stream traz
 * `cd x && npm run lint`, ou vem truncado no resumo de uma linha do feed).
 */
export function casaComando(relatado: string, doStream: string): boolean {
  const r = normalizarComando(relatado);
  const s = normalizarComando(doStream);
  if (!r || !s) return false;
  if (r === s || s.includes(r)) return true;
  // Stream truncado: o relatado começa com o que o feed guardou (mínimo útil).
  return s.length >= 12 && r.startsWith(s);
}

/** O que o stream mostrou para um comando relatado (o melhor resultado entre os que casam). */
export function resultadoNoStream(
  relatado: string,
  stream: readonly ComandoDoStream[],
): ComandoVerificado['no_stream'] {
  const casados = stream.filter((c) => casaComando(relatado, c.comando));
  if (casados.some((c) => c.resultado === 'exit_0')) return 'exit_0';
  if (casados.some((c) => c.resultado === 'erro')) return 'erro';
  return 'nao_visto';
}

export function calcularNivelVerificacao(entrada: {
  /** `veredito.v1.comandos_executados`. */
  relatados: readonly { comando: string; exit_code: number | null; resumo: string }[];
  /** Bash do stream do T2 (`tool_use` + `tool_result`). */
  stream: readonly ComandoDoStream[];
}): CalculoNivel {
  const comandos: ComandoVerificado[] = entrada.relatados.map((c) => ({
    comando: c.comando,
    exit_code: c.exit_code,
    resumo: c.resumo,
    no_stream: resultadoNoStream(c.comando, entrada.stream),
  }));
  if (comandos.length === 0) {
    return {
      nivel: 'nao_verificado',
      motivo: 'a revisão não relatou nenhum comando executado',
      comandos,
    };
  }
  const naoVistos = comandos.filter((c) => c.no_stream === 'nao_visto');
  const vermelhos = comandos.filter(
    (c) => c.no_stream !== 'nao_visto' && (c.exit_code !== 0 || c.no_stream === 'erro'),
  );
  if (naoVistos.length === 0 && vermelhos.length === 0) {
    return {
      nivel: 'verificado_pelo_revisor',
      motivo: 'todos os comandos relatados aparecem no stream da revisão com exit 0',
      comandos,
    };
  }
  const partes = [
    naoVistos.length ? `não vistos no stream: ${naoVistos.map((c) => c.comando).join(', ')}` : '',
    vermelhos.length
      ? `vermelhos ou divergentes: ${vermelhos
          .map((c) => `${c.comando} (relatado exit ${c.exit_code ?? '?'}, stream ${c.no_stream})`)
          .join(', ')}`
      : '',
  ].filter(Boolean);
  return { nivel: 'declarado', motivo: partes.join('; '), comandos };
}

/**
 * Comandos de verificação/instalação no meio dos Bash de um turno (FJ-032):
 * o que o T1 rodou e vale mostrar ao T2 e na aprovação (não `ls`, `cat`, `git`…).
 */
const PADRAO_VERIFICACAO =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+|exec\s+)?(test|tests|lint|build|typecheck|type-check|check|check-types|tsc|e2e|ci|install|i|format|verify)\b|\b(npx|bunx)\s+(tsc|vitest|jest|eslint|prettier|playwright|cypress|mocha|biome)\b|(^|[\s;&|(])(tsc|vitest|jest|eslint|pytest|phpunit|rspec|mypy|ruff)\b|\b(cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|make\s+\S+|mvn\s+\S+|gradle\w*\s+\S+|dotnet\s+(test|build)|composer\s+(install|test)|bundle\s+exec)\b/;

export function ehComandoDeVerificacao(comando: string): boolean {
  return PADRAO_VERIFICACAO.test(comando);
}

// ---------------------------------------------------------------------------
// Evidência visual (03 §5.4, tabela "Resultado")
// ---------------------------------------------------------------------------

/** Por que não houve evidência nenhuma (`sem_evidencia_visual`). */
export const MotivoSemEvidencia = {
  telas_ausentes: 'telas_ausentes',
  agente_sem_evidencia: 'agente_sem_evidencia',
  app_nao_subiu: 'app_nao_subiu',
  login_falhou: 'login_falhou',
  nenhuma_tela: 'nenhuma_tela',
} as const;
export type MotivoSemEvidencia = (typeof MotivoSemEvidencia)[keyof typeof MotivoSemEvidencia];

export const TEXTO_MOTIVO_SEM_EVIDENCIA: Record<MotivoSemEvidencia, string> = {
  telas_ausentes: 'o agente não registrou evidências (evidencias/telas.json ausente)',
  agente_sem_evidencia: 'o agente não conseguiu fotografar',
  app_nao_subiu: 'o app não subiu',
  login_falhou: 'o login no app falhou',
  nenhuma_tela: 'nenhuma tela declarada',
};

export interface ParTela {
  tela_id: string;
  antes: ResultadoTela | null;
  depois: ResultadoTela | null;
}

const ANTES_VALIDO: ReadonlySet<ResultadoTela> = new Set(['ok', 'reaproveitado', 'tela_nova']);
const DEPOIS_VALIDO: ReadonlySet<ResultadoTela> = new Set(['ok', 'reaproveitado']);

export interface CalculoEvidencia {
  evidencia_visual: EvidenciaVisual;
  motivo: string | null;
}

/**
 * `execucao.evidencia_visual` + motivo. `falhaGeral` = o pior motivo de
 * `sem_evidencia_visual` visto num dos sub-passos (o chamador passa o do
 * `depois`, ou o do `antes` se ele impediu tudo).
 */
export function calcularEvidenciaVisual(entrada: {
  alteraUi: boolean;
  pares: readonly ParTela[];
  falhaGeral?: MotivoSemEvidencia | null;
}): CalculoEvidencia {
  if (!entrada.alteraUi) return { evidencia_visual: 'nao_se_aplica', motivo: null };
  if (entrada.falhaGeral) {
    return {
      evidencia_visual: 'sem_evidencia_visual',
      motivo: TEXTO_MOTIVO_SEM_EVIDENCIA[entrada.falhaGeral],
    };
  }
  if (entrada.pares.length === 0) {
    return {
      evidencia_visual: 'sem_evidencia_visual',
      motivo: TEXTO_MOTIVO_SEM_EVIDENCIA.nenhuma_tela,
    };
  }
  const geral = entrada.pares.find(
    (p) =>
      p.antes === 'login_falhou' ||
      p.depois === 'login_falhou' ||
      p.antes === 'app_nao_subiu' ||
      p.depois === 'app_nao_subiu',
  );
  if (geral) {
    const m =
      geral.antes === 'login_falhou' || geral.depois === 'login_falhou'
        ? 'login_falhou'
        : 'app_nao_subiu';
    return { evidencia_visual: 'sem_evidencia_visual', motivo: TEXTO_MOTIVO_SEM_EVIDENCIA[m] };
  }
  const semPar = entrada.pares.filter(
    (p) => !(p.antes && ANTES_VALIDO.has(p.antes) && p.depois && DEPOIS_VALIDO.has(p.depois)),
  );
  if (semPar.length === 0) return { evidencia_visual: 'completa', motivo: null };
  return {
    evidencia_visual: 'parcial',
    motivo: `sem par antes/depois: ${semPar
      .map((p) => `${p.tela_id} (antes: ${p.antes ?? '—'}, depois: ${p.depois ?? '—'})`)
      .join(', ')}`,
  };
}
