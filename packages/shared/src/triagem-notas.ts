/**
 * Helpers PUROS de formatação das saídas da triagem de IA (M7 — specs/05 §5, §7,
 * §8). ZERO dependências de infra: recebem dados já sanitizados/derivados pelo
 * worker e devolvem texto pronto para virar `Mensagem` (pública/interna).
 *
 * Ficam em `@chamados/shared` (e não no worker) porque são determinísticos e
 * testáveis isoladamente, e porque tanto o pipeline (aplicador) quanto o
 * `FakeProvider` os consomem — garantindo que a SPEC gerada siga SEMPRE o
 * template canônico de specs/05 §7, independentemente do engine.
 *
 * IMPORTANTE (defesa a prompt injection — specs/05 §9): o "pedido do cliente"
 * entra aqui como RESUMO NEUTRO já sanitizado pelo modelo, nunca o texto cru; e
 * as perguntas ao cliente nunca ecoam caminhos de código, queries ou segredos.
 */
import type { Complexidade, Natureza, Prioridade } from './enums';

// ---------------------------------------------------------------------------
// Perguntas ao cliente (specs/05 §5.3) — mensagem PÚBLICA
// ---------------------------------------------------------------------------

/**
 * Formata as perguntas ao cliente como UMA mensagem pública objetiva e numerada
 * (specs/05 §5.3): linguagem do cliente, sem jargão interno, explica brevemente
 * o porquê (transparência). Limita a 5 perguntas (o excedente é descartado).
 */
export function formatarPerguntasCliente(perguntas: string[]): string {
  const limpas = perguntas
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 5);
  const numeradas =
    limpas.length > 0
      ? limpas.map((p, i) => `${i + 1}. ${p}`).join('\n')
      : '1. Você poderia detalhar o que aconteceu, com o passo a passo para reproduzir?';
  return [
    'Olá! Para avançar com o seu chamado, preciso de alguns detalhes:',
    '',
    numeradas,
    '',
    'Assim que você responder, retomo a análise automaticamente. Obrigado!',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Nota interna de diagnóstico (specs/05 §5.2) — visibilidade INTERNA
// ---------------------------------------------------------------------------

export interface DadosNotaDiagnostico {
  diagnostico: string;
  confianca: number;
  complexidade: Complexidade | null;
  /** Natureza atual e sugerida; quando divergem, registra a reclassificação. */
  naturezaAtual: Natureza;
  naturezaAjustada: Natureza | null;
  /** Prioridade efetivamente aplicada pela IA (quando o chamado é "virgem"). */
  prioridadeAplicada: Prioridade | null;
  /** Prioridade apenas SUGERIDA (quando um operador já tocou o chamado). */
  prioridadeSugerida: Prioridade | null;
}

/**
 * Monta a nota interna de diagnóstico (template curto: resumo, evidências, causa
 * provável) + o registro das classificações aplicadas/sugeridas (specs/05 §5.2).
 * O `diagnostico` do provider já traz resumo/evidências/causa; aqui apenas
 * enquadramos e anexamos as decisões de classificação de forma auditável.
 */
export function montarNotaDiagnostico(d: DadosNotaDiagnostico): string {
  const linhas: string[] = [
    'Diagnóstico automático (Assistente IA)',
    '',
    d.diagnostico.trim() || '(sem detalhamento)',
    '',
    `Confiança da análise: ${(Math.round(d.confianca * 100) / 100).toFixed(2)}`,
  ];
  if (d.complexidade) linhas.push(`Complexidade avaliada: ${d.complexidade}`);
  if (d.naturezaAjustada && d.naturezaAjustada !== d.naturezaAtual) {
    linhas.push(`Natureza reclassificada: ${d.naturezaAtual} → ${d.naturezaAjustada}`);
  }
  if (d.prioridadeAplicada) {
    linhas.push(`Prioridade ajustada automaticamente para: ${d.prioridadeAplicada}`);
  } else if (d.prioridadeSugerida) {
    linhas.push(
      `Prioridade sugerida: ${d.prioridadeSugerida} (o chamado já foi tocado por um operador — ` +
        'aplicação fica a critério do operador).',
    );
  }
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------
// Nota interna de escalonamento por falha (specs/05 §8)
// ---------------------------------------------------------------------------

/**
 * Nota interna curta explicando a falha da triagem e o encaminhamento a um
 * humano (specs/05 §8: o chamado nunca fica preso sem responsável). NUNCA ecoa
 * segredos/stack traces crus — apenas o motivo já normalizado (ex.: 'timeout').
 */
export function montarNotaEscalonamento(motivo: string): string {
  return [
    'Triagem automática não concluída — encaminhado para atendimento humano.',
    '',
    `Motivo: ${motivo.trim() || 'erro_desconhecido'}.`,
    '',
    'Um operador deve assumir a análise deste chamado.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SPEC de alteração (specs/05 §7) — nota INTERNA, template OBRIGATÓRIO
// ---------------------------------------------------------------------------

export interface DadosTemplateSpec {
  titulo: string;
  sistemaAlvoNome: string;
  sistemaAlvoStack: string | null;
  /** Número do chamado (ex.: "42"); vira "#42" no cabeçalho. */
  chamadoNumero: string;
  complexidade: Complexidade;
  /** Resumo NEUTRO e sanitizado do pedido (specs/05 §7/§9 — nunca o texto cru). */
  pedidoResumo: string;
  /** Diagnóstico/análise do modelo (embasa "Estado atual"/"Mudanças propostas"). */
  analise?: string | null;
  objetivo?: string | null;
  comportamentoDesejado?: string | null;
  mudancasPropostas?: string[] | null;
  criteriosAceite?: string[] | null;
  riscos?: string | null;
  esforco?: string | null;
}

/** Marca de itens ainda não detalhados (a serem preenchidos pelo dev/operador). */
const A_DETALHAR = '<a detalhar>';

function bloco(itens: string[] | null | undefined, prefixo = '- '): string {
  const arr = (itens ?? []).map((i) => i.trim()).filter((i) => i.length > 0);
  if (arr.length === 0) return `${prefixo}${A_DETALHAR}`;
  return arr.map((i) => `${prefixo}${i}`).join('\n');
}

/**
 * Monta a SPEC de alteração seguindo o TEMPLATE COMPLETO de specs/05 §7 — pronta
 * para colar numa IA de desenvolvimento. Campos não fornecidos viram `<a
 * detalhar>` (a SPEC continua estruturalmente completa). O `pedidoResumo` é o
 * pedido do cliente já neutralizado/sanitizado (specs/05 §7/§9), nunca cru.
 */
export function montarTemplateSpec(d: DadosTemplateSpec): string {
  const stack = d.sistemaAlvoStack ?? A_DETALHAR;
  const objetivo = d.objetivo?.trim() || d.pedidoResumo.trim() || A_DETALHAR;
  const estadoAtual = d.analise?.trim() || A_DETALHAR;
  const comportamento = d.comportamentoDesejado?.trim() || d.pedidoResumo.trim() || A_DETALHAR;
  const criterios = (d.criteriosAceite ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  const criteriosBloco =
    criterios.length > 0 ? criterios.map((c) => `- [ ] ${c}`).join('\n') : `- [ ] ${A_DETALHAR}`;

  return [
    `# SPEC — ${d.titulo.trim()}`,
    '',
    '## Contexto',
    '',
    `Sistema-alvo: ${d.sistemaAlvoNome} (${stack})`,
    `Chamado: #${d.chamadoNumero} | Natureza: alteracao | Complexidade: ${d.complexidade}`,
    `Pedido do cliente (resumo neutro): ${d.pedidoResumo.trim() || A_DETALHAR}`,
    '',
    '## Objetivo',
    '',
    objetivo,
    '',
    '## Escopo',
    '',
    `- Incluído: ${d.pedidoResumo.trim() || A_DETALHAR}`,
    `- Fora de escopo: ${A_DETALHAR}`,
    '',
    '## Estado atual',
    '',
    estadoAtual,
    '',
    '## Comportamento desejado',
    '',
    comportamento,
    '',
    '## Mudanças propostas',
    '',
    bloco(d.mudancasPropostas),
    `- Contratos/API afetados: ${A_DETALHAR}`,
    `- Migração de dados: ${A_DETALHAR}`,
    '',
    '## Critérios de aceite',
    '',
    criteriosBloco,
    '',
    '## Riscos e considerações',
    '',
    d.riscos?.trim() || A_DETALHAR,
    '',
    '## Estimativa',
    '',
    `Complexidade: ${d.complexidade} | Esforço aproximado: ${d.esforco?.trim() || A_DETALHAR}`,
  ].join('\n');
}
