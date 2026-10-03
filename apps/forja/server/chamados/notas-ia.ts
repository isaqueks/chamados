import { MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO } from '@chamados/shared';
import type { MensagemChamado } from '@chamados/cliente-api';
import { limparMarcasLinha, normalizarCorpo, primeiraLinha } from './normalizacao';

/**
 * Reconhecimento das notas da IA do SERVIDOR (specs/forja/07 §4).
 *
 * POR QUE por texto: a API não expõe `execucao_ia_id` [V: 02 §1.4], então o
 * diagnóstico, a SPEC, o PR e o escalonamento da triagem são reconhecidos pelos
 * marcadores que os construtores de `@chamados/shared/triagem-notas.ts`
 * escrevem, sobre o detalhe pedido em `?formato=markdown`. O teste de contrato
 * (`notas-ia.test.ts`) importa esses construtores e verifica que o classificador
 * reconhece a saída deles: mudar o texto no Chamados quebra o teste, não a
 * produção.
 *
 * Regras de 07 §4:
 *  - filtro base: `interna` ∧ `autor_papel = agente_ia` (a pública "em revisão"
 *    é a única exceção, com o texto exato de `MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO`);
 *  - a SPEC nem sempre usa o template literal → heurística (`# SPEC` no início
 *    ou `## Critérios de aceite`), só quando nenhum marcador casa;
 *  - "use a mais recente": a timeline vem ASC e cada resposta do cliente gera
 *    uma rodada nova; as anteriores ficam acessíveis, mas não vão ao planejador;
 *  - falha de parsing degrada para `outra_ia` e NUNCA lança.
 *
 * Tudo aqui é DADO NÃO CONFIÁVEL derivado do texto do cliente (07 §4, F-03).
 */

/** Marcadores (1ª linha / conteúdo) — espelham `triagem-notas.ts` (linhas citadas em 07 §4). */
export const MARCADORES_IA = {
  diagnostico: 'Diagnóstico automático (Assistente IA)',
  pr: 'Resolução automática (Assistente IA) — Pull Request aguardando revisão',
  falha_resolucao: 'Tentativa de resolução automática NÃO concluída (Assistente IA).',
  escalonamento: 'Triagem automática não concluída — encaminhado para atendimento humano.',
} as const;

export const TipoNotaIa = {
  diagnostico: 'diagnostico',
  pr: 'pr',
  falha_resolucao: 'falha_resolucao',
  escalonamento: 'escalonamento',
  spec: 'spec',
  publica_em_revisao: 'publica_em_revisao',
  /** Nota da IA que não casa com nenhum marcador: vai ao planejador rotulada como tal. */
  outra_ia: 'outra_ia',
} as const;
export type TipoNotaIa = (typeof TipoNotaIa)[keyof typeof TipoNotaIa];

/** Branch de resolução da IA (`nomeBranchResolucao` = `ia/chamado-<n>-<slug>`). */
const RE_BRANCH_IA = /\bia\/chamado-(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*/;
const RE_URL = /https?:\/\/[^\s<>()[\]]+/;

export interface PrIa {
  branch: string | null;
  /** Número do chamado embutido na branch (`ia/chamado-<n>-…`). */
  numero_na_branch: number | null;
  pr_url: string | null;
}

export interface NotaIaClassificada {
  tipo: TipoNotaIa;
  mensagem: MensagemChamado;
  /** Só para `pr`. */
  pr: PrIa | null;
}

const MARCADOR_NORMALIZADO = Object.fromEntries(
  Object.entries(MARCADORES_IA).map(([k, v]) => [k, normalizarCorpo(v)]),
) as Record<keyof typeof MARCADORES_IA, string>;
const PUBLICA_EM_REVISAO = normalizarCorpo(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO);

/** É uma mensagem do `agente_ia` do servidor (nunca da Forja, que é `operador`)? */
export function ehMensagemDaIa(m: MensagemChamado): boolean {
  return m.autor_papel === 'agente_ia';
}

/**
 * Extrai `Branch:`/`Branch publicada:`/`Pull Request:` de uma nota de PR.
 * Tolera o markdown devolvido pela API (escapes, `<url>`, `[url](url)`, crases).
 */
export function extrairPrIa(corpo: string): PrIa {
  let branch: string | null = null;
  let prUrl: string | null = null;
  for (const bruta of corpo.split(/\r?\n/)) {
    const linha = limparMarcasLinha(bruta).replace(/`/g, '');
    const rotulo = /^(Pull Request|Branch publicada|Branch)\s*:\s*(.*)$/i.exec(linha);
    if (!rotulo) continue;
    const valor = rotulo[2] ?? '';
    if (/^pull request$/i.test(rotulo[1]!)) {
      prUrl ??= RE_URL.exec(valor)?.[0]?.replace(/[.,;]+$/, '') ?? null;
    } else {
      branch ??= RE_BRANCH_IA.exec(valor)?.[0] ?? null;
    }
  }
  branch ??= RE_BRANCH_IA.exec(normalizarCorpo(corpo))?.[0] ?? null;
  const numero = branch ? Number(RE_BRANCH_IA.exec(branch)?.[1]) : NaN;
  return { branch, numero_na_branch: Number.isFinite(numero) ? numero : null, pr_url: prUrl };
}

/** Heurística da SPEC (07 §4): começa com `# SPEC` ou contém `## Critérios de aceite`. */
export function pareceSpec(corpo: string): boolean {
  const linhas = corpo.split(/\r?\n/).map((l) => normalizarCorpo(l));
  const primeira = linhas.find((l) => l.length > 0) ?? '';
  if (/^#\s+SPEC\b/i.test(primeira)) return true;
  return linhas.some((l) => /^##\s+Crit[eé]rios de aceite\b/i.test(l));
}

/**
 * Classifica UMA mensagem. `null` = não é da IA do servidor (cliente, equipe ou
 * a própria Forja). Nunca lança.
 */
export function classificarMensagem(m: MensagemChamado): NotaIaClassificada | null {
  if (!ehMensagemDaIa(m)) return null;
  try {
    const corpo = m.corpo ?? '';
    if (m.visibilidade === 'publica') {
      return normalizarCorpo(corpo) === PUBLICA_EM_REVISAO
        ? { tipo: 'publica_em_revisao', mensagem: m, pr: null }
        : null;
    }
    // Sem `visibilidade` (projeção de cliente) não dá para afirmar que é nota interna.
    if (m.visibilidade !== 'interna') return null;
    const linha1 = primeiraLinha(corpo);
    const tudo = normalizarCorpo(corpo);
    if (linha1.startsWith(MARCADOR_NORMALIZADO.pr)) {
      return { tipo: 'pr', mensagem: m, pr: extrairPrIa(corpo) };
    }
    if (
      linha1.startsWith(MARCADOR_NORMALIZADO.diagnostico) &&
      tudo.includes('Confiança da análise:')
    ) {
      return { tipo: 'diagnostico', mensagem: m, pr: null };
    }
    if (linha1.startsWith(MARCADOR_NORMALIZADO.falha_resolucao)) {
      return { tipo: 'falha_resolucao', mensagem: m, pr: null };
    }
    if (linha1.startsWith(MARCADOR_NORMALIZADO.escalonamento)) {
      return { tipo: 'escalonamento', mensagem: m, pr: null };
    }
    if (pareceSpec(corpo)) return { tipo: 'spec', mensagem: m, pr: null };
    return { tipo: 'outra_ia', mensagem: m, pr: null };
  } catch {
    return { tipo: 'outra_ia', mensagem: m, pr: null };
  }
}

/** Visão das notas da IA de um detalhe: a MAIS RECENTE de cada tipo + o histórico. */
export interface NotasIa {
  diagnostico: NotaIaClassificada | null;
  spec: NotaIaClassificada | null;
  pr: NotaIaClassificada | null;
  falha_resolucao: NotaIaClassificada | null;
  escalonamento: NotaIaClassificada | null;
  publica_em_revisao: NotaIaClassificada | null;
  /** Notas da IA não classificadas (todas, em ordem ASC). */
  outras: NotaIaClassificada[];
  /** Todas as classificadas, em ordem ASC (painel da execução). */
  todas: NotaIaClassificada[];
}

/** Agrupa a timeline (ordem ASC da API): para cada tipo, vale a ÚLTIMA (07 §4). */
export function extrairNotasIa(mensagens: readonly MensagemChamado[]): NotasIa {
  const notas: NotasIa = {
    diagnostico: null,
    spec: null,
    pr: null,
    falha_resolucao: null,
    escalonamento: null,
    publica_em_revisao: null,
    outras: [],
    todas: [],
  };
  for (const m of mensagens) {
    const c = classificarMensagem(m);
    if (!c) continue;
    notas.todas.push(c);
    if (c.tipo === 'outra_ia') notas.outras.push(c);
    else notas[c.tipo] = c;
  }
  return notas;
}
