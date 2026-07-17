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

// ---------------------------------------------------------------------------
// Resolução automática (specs/05 §6) — branch/commit/PR e notas INTERNAS
// ---------------------------------------------------------------------------

/**
 * Slug rastreável a partir do título (specs/05 §6: `ia/chamado-<numero>-<slug>`).
 * Só ASCII minúsculo/dígitos/hífen; sem acentos, sem espaços; comprimento capado.
 * Nunca vazio (fallback `chamado`), para a branch ser sempre válida.
 */
export function slugChamado(titulo: string, maxLen = 40): string {
  const s = titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos combinantes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'chamado';
}

/** Nome da branch de resolução (specs/05 §6). Determinístico por chamado. */
export function nomeBranchResolucao(numero: string | number, titulo: string): string {
  return `ia/chamado-${numero}-${slugChamado(titulo)}`;
}

export interface DadosCommit {
  numero: string | number;
  titulo: string;
  execucaoId: string;
  resumo: string;
}

/**
 * Mensagem de commit padronizada (specs/05 §6): referencia o Chamado e a
 * `ExecucaoIA` que originou a mudança, para rastreabilidade. Nunca ecoa segredos.
 */
export function montarMensagemCommit(d: DadosCommit): string {
  const assunto = `fix: chamado #${d.numero} — ${d.titulo.trim()}`.slice(0, 100);
  return [
    assunto,
    '',
    d.resumo.trim() || 'Correção automática proposta pelo assistente de IA.',
    '',
    `Chamado: #${d.numero}`,
    `ExecucaoIA: ${d.execucaoId}`,
    '',
    'Gerado automaticamente pelo assistente de IA (Chamados). Requer revisão',
    'humana — a IA nunca faz merge nem deploy.',
  ].join('\n');
}

export interface DadosPr {
  numero: string | number;
  titulo: string;
  diagnostico?: string | null;
  resumo: string;
  arquivos: string[];
  execucaoId: string;
  /** Link do chamado no painel (quando derivável); senão `null`. */
  chamadoUrl?: string | null;
}

/** Título do PR (specs/05 §6). */
export function montarTituloPr(d: DadosPr): string {
  return `Chamados #${d.numero}: ${d.titulo.trim()}`.slice(0, 120);
}

/**
 * Corpo do PR (specs/05 §6): diagnóstico + resumo da mudança + arquivos + link do
 * chamado + `ExecucaoIA`, com o guardrail explícito (merge/deploy só humano).
 */
export function montarCorpoPr(d: DadosPr): string {
  const linhas: string[] = [
    `Correção automática proposta para o chamado **#${d.numero} — ${d.titulo.trim()}**.`,
    '',
  ];
  if (d.diagnostico && d.diagnostico.trim()) {
    linhas.push('## Diagnóstico', '', d.diagnostico.trim(), '');
  }
  linhas.push('## Resumo da mudança', '', d.resumo.trim() || A_DETALHAR, '');
  linhas.push('## Arquivos alterados', '', bloco(d.arquivos), '');
  if (d.chamadoUrl && d.chamadoUrl.trim()) {
    linhas.push(`Chamado: ${d.chamadoUrl.trim()}`);
  }
  linhas.push(`ExecucaoIA: ${d.execucaoId}`);
  linhas.push(
    '',
    '> Gerado automaticamente pelo assistente de IA. **Requer revisão humana** —',
    '> a IA nunca faz merge nem deploy (guardrail inegociável).',
  );
  return linhas.join('\n');
}

export interface DadosNotaResolucao {
  branch: string;
  /** URL do PR (GitHub); `null` quando só houve push (PR manual). */
  prUrl: string | null;
  resumo: string;
  arquivos: string[];
}

/**
 * Nota INTERNA de resultado da resolução automática (specs/05 §6): link do PR (ou
 * instrução de PR manual), resumo da mudança, arquivos tocados e a branch. Nunca
 * exposta ao cliente (visibilidade interna + evento `ia_abriu_pr` interno).
 */
export function montarNotaResolucaoPr(d: DadosNotaResolucao): string {
  const linhas: string[] = [
    'Resolução automática (Assistente IA) — Pull Request aguardando revisão',
    '',
  ];
  if (d.prUrl) {
    linhas.push(`Pull Request: ${d.prUrl}`);
  } else {
    linhas.push(
      `Branch publicada: ${d.branch}`,
      'Abra o Pull Request manualmente a partir desta branch no seu provedor git',
      '(o host não é GitHub, então o PR não pôde ser criado automaticamente).',
    );
  }
  linhas.push(
    `Branch: ${d.branch}`,
    '',
    'Resumo da mudança:',
    d.resumo.trim() || '(sem resumo)',
    '',
    'Arquivos alterados:',
    bloco(d.arquivos),
    '',
    'A IA NÃO faz merge nem deploy — a aprovação e o merge são manuais (guardrail).',
  );
  return linhas.join('\n');
}

/**
 * Nota INTERNA de FALHA da tentativa de resolução (specs/05 §6/§8). O diagnóstico
 * já aplicado permanece; apenas a tentativa de PR falhou e o chamado segue com o
 * operador. Nunca ecoa segredos/stack traces crus — só o motivo normalizado.
 */
export function montarNotaFalhaResolucao(motivo: string): string {
  return [
    'Tentativa de resolução automática NÃO concluída (Assistente IA).',
    '',
    `Motivo: ${motivo.trim() || 'erro_desconhecido'}.`,
    '',
    'O diagnóstico acima permanece válido. Nenhuma alteração foi enviada ao',
    'repositório do sistema-alvo. Um operador deve conduzir a correção.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Separação técnica/pública (D-015) — validador conservador de resposta ao cliente
// ---------------------------------------------------------------------------

/**
 * Mensagem PÚBLICA genérica usada quando a resposta ao cliente proposta pela IA é
 * REBAIXADA pelo validador (continha cara de conteúdo técnico). O detalhe técnico
 * NÃO é publicado ao cliente — fica na nota interna.
 */
export const RESPOSTA_PUBLICA_FALLBACK =
  'Analisamos seu chamado e nossa equipe já está cuidando disso; em breve retornamos com uma posição.';

/** Resultado da inspeção de uma mensagem pública quanto a conteúdo técnico. */
export interface DeteccaoTecnica {
  /** A mensagem tem cara de conteúdo técnico (não deve ir ao cliente)? */
  tecnica: boolean;
  /** Rótulos dos padrões detectados (para auditar na nota interna). */
  motivos: string[];
}

/**
 * Padrões CONSERVADORES de "cara de técnico" numa mensagem que iria ao cliente
 * (D-015). Foco em sinais inequívocos — blocos de código, caminhos de arquivo,
 * nomes de arquivo de código, chamadas de função em `camelCase`/`snake_case`/
 * método, SQL e stack traces — evitando disparar com linguagem comum de
 * atendimento em pt-BR (acentos, `usuário(s)`, `(cinco reais)`, valores `1.000,00`).
 */
const PADROES_TECNICOS: ReadonlyArray<{ rotulo: string; re: RegExp }> = [
  { rotulo: 'bloco de código', re: /```|~~~/ },
  // Caminho com pasta de código conhecida (src/…, apps/…, packages/…, etc.).
  {
    rotulo: 'caminho de arquivo',
    re: /(?:^|[\s("'`>[])(?:src|apps|packages|dist|build|node_modules|lib|migrations?|tests?|__tests__)\/[\w./-]+/i,
  },
  // Caminho absoluto do Windows (C:\... ou C:/...).
  { rotulo: 'caminho windows', re: /[A-Za-z]:[\\/][\\/\w.-]+/ },
  // Nome de arquivo com extensão de CÓDIGO (algo.js/.ts/.sql/.py/…).
  {
    rotulo: 'arquivo de código',
    re: /\b[\w-]+\.(?:jsx?|tsx?|mjs|cjs|py|rb|go|rs|php|java|cs|sql|sh|json|ya?ml)\b/i,
  },
  // Chamada de função: método `obj.metodo(`, `camelCase(` ou `snake_case(` — nunca
  // `usuário(s)`/`(algo)` (que têm espaço antes do parêntese ou não são identificadores de código).
  { rotulo: 'chamada de método', re: /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/ },
  { rotulo: 'chamada camelCase', re: /\b[a-z$][\w$]*[A-Z][\w$]*\s*\(/ },
  { rotulo: 'chamada snake_case', re: /\b[a-z$][a-z0-9$]*_[\w$]*\s*\(/i },
  // SQL estruturado (exige a forma completa — não dispara com "delete"/"select" soltos).
  { rotulo: 'sql', re: /\bSELECT\b[\s\S]{0,200}?\bFROM\b/i },
  { rotulo: 'sql', re: /\bINSERT\s+INTO\b/i },
  { rotulo: 'sql', re: /\bUPDATE\b[\s\S]{0,120}?\bSET\b/i },
  { rotulo: 'sql', re: /\bDELETE\s+FROM\b/i },
  { rotulo: 'sql', re: /\b(?:DROP|CREATE|ALTER)\s+(?:TABLE|DATABASE|INDEX|VIEW)\b/i },
  // Stack trace: "at Algo (arquivo:linha:coluna)" — muito específico (evita "chat"/"até").
  { rotulo: 'stack trace', re: /\bat\s+[^\n(]+\([^)]*:\d+:\d+\)/ },
];

/**
 * Inspeciona uma mensagem que iria ao CLIENTE e detecta, de forma CONSERVADORA, se
 * ela tem cara de conteúdo técnico (D-015): blocos de código, caminhos de arquivo,
 * nomes de arquivo de código, chamadas de função, SQL ou stack trace. Projetado
 * para NÃO gerar falso-positivo com linguagem comum de atendimento em pt-BR. Puro
 * e determinístico — testado dos dois lados.
 */
export function detectarConteudoTecnico(texto: string): DeteccaoTecnica {
  const alvo = (texto ?? '').trim();
  if (alvo.length === 0) return { tecnica: false, motivos: [] };
  const motivos: string[] = [];
  for (const { rotulo, re } of PADROES_TECNICOS) {
    if (re.test(alvo) && !motivos.includes(rotulo)) motivos.push(rotulo);
  }
  return { tecnica: motivos.length > 0, motivos };
}

/**
 * Trecho a ANEXAR ao final da nota interna quando a resposta pública foi rebaixada
 * pelo validador (D-015): registra o aviso, os padrões detectados e PRESERVA o
 * texto original proposto pela IA (que NÃO foi ao cliente) para o operador avaliar.
 */
export function montarAvisoRespostaRebaixada(original: string, motivos: string[]): string {
  return [
    '',
    '---',
    'Resposta pública rebaixada pelo validador: a mensagem proposta ao cliente continha',
    'conteúdo com cara de técnico e NÃO foi publicada — o cliente recebeu uma resposta',
    'genérica no lugar.',
    motivos.length > 0 ? `Padrões detectados: ${motivos.join(', ')}.` : '',
    'Texto original proposto pela IA (mantido apenas nesta nota interna):',
    original.trim() || '(vazio)',
  ]
    .filter((linha, i) => !(linha === '' && i > 0))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Promessa FALSA de resolução (D-022) — validador da resposta pública
// ---------------------------------------------------------------------------

/** Resultado da inspeção quanto a AFIRMAÇÃO de correção já concluída. */
export interface DeteccaoPromessa {
  /** A mensagem afirma que o problema JÁ FOI resolvido/corrigido? */
  promete: boolean;
  /** Rótulos dos padrões detectados (para auditar na nota interna). */
  motivos: string[];
}

/**
 * Padrões CONSERVADORES de afirmação de correção CONCLUÍDA numa mensagem que iria
 * ao cliente (D-022). A tentativa de resolução da IA é sempre uma PROPOSTA (PR
 * aguardando revisão humana) — dizer "resolvido/corrigido" ao cliente é FALSO até
 * o deploy. Foco em formas de fato consumado ("resolvi", "foi corrigido", "já
 * está funcionando"); formas de futuro/intenção ("vamos corrigir", "será
 * resolvido", "estamos analisando") NÃO disparam.
 */
const PADROES_PROMESSA: ReadonlyArray<{ rotulo: string; re: RegExp }> = [
  // 1ª pessoa no perfeito: "resolvi", "corrigimos", "consertei", "implementei", "apliquei a correção".
  {
    rotulo: 'correção em 1ª pessoa',
    re: /\b(?:resolvi|resolvemos|corrigi|corrigimos|consertei|consertamos|implementei|implementamos|apliquei|aplicamos)\b/i,
  },
  // Fato consumado: "foi/está/já foi/já está resolvido|corrigido|consertado|implementado|normalizado|ajustado".
  {
    rotulo: 'correção como fato consumado',
    re: /\b(?:foi|foram|está|estão)\s+(?:resolvid|corrigid|consertad|implementad|normalizad|ajustad)\w*\b/i,
  },
  // "problema resolvido"/"erro corrigido" (particípio direto após o substantivo).
  {
    rotulo: 'problema dado como resolvido',
    re: /\b(?:problema|erro|falha|defeito)s?\s+(?:resolvid|corrigid|consertad|solucionad)\w*\b/i,
  },
  // "correção (foi) aplicada/realizada/feita/publicada/implantada".
  {
    rotulo: 'correção dada como aplicada',
    re: /\bcorreç(?:ão|ões)\s+(?:foi\s+|já\s+)?(?:aplicad|realizad|feit|publicad|implantad)\w*\b/i,
  },
  // "voltou a funcionar" / "já está funcionando" / "deve estar funcionando".
  {
    rotulo: 'funcionamento dado como restabelecido',
    re: /\b(?:voltou\s+a\s+funcionar|(?:já\s+está|deve\s+estar)\s+funcionando)\b/i,
  },
];

/**
 * Inspeciona a resposta que iria ao CLIENTE e detecta, de forma conservadora, se
 * ela AFIRMA correção já concluída (D-022). Usada pelo aplicador nos fluxos
 * problema/alteracao (nunca em dúvida, onde a resposta em si resolve o chamado):
 * detectada a promessa, a resposta é REBAIXADA para a genérica ("equipe está
 * analisando") e o texto original vai para a nota interna. Pura e determinística.
 */
export function detectarPromessaResolucao(texto: string): DeteccaoPromessa {
  const alvo = (texto ?? '').trim();
  if (alvo.length === 0) return { promete: false, motivos: [] };
  const motivos: string[] = [];
  for (const { rotulo, re } of PADROES_PROMESSA) {
    if (re.test(alvo) && !motivos.includes(rotulo)) motivos.push(rotulo);
  }
  return { promete: motivos.length > 0, motivos };
}

/**
 * Aviso anexado à nota interna quando a resposta pública foi rebaixada por
 * PROMETER resolução (D-022) — espelha `montarAvisoRespostaRebaixada`, com o
 * motivo específico: a correção da IA é proposta em revisão, não fato.
 */
export function montarAvisoPromessaRebaixada(original: string, motivos: string[]): string {
  return [
    '',
    '---',
    'Resposta pública rebaixada pelo validador: a mensagem proposta ao cliente AFIRMAVA que o',
    'problema já estava resolvido/corrigido — mas a correção da IA é apenas uma PROPOSTA que',
    'aguarda revisão humana (PR); nada foi publicado em produção. O cliente recebeu uma resposta',
    'genérica no lugar.',
    motivos.length > 0 ? `Padrões detectados: ${motivos.join(', ')}.` : '',
    'Texto original proposto pela IA (mantido apenas nesta nota interna):',
    original.trim() || '(vazio)',
  ]
    .filter((linha, i) => !(linha === '' && i > 0))
    .join('\n');
}

/**
 * Mensagem PÚBLICA publicada pelo PIPELINE (nunca pelo modelo) quando a tentativa
 * de resolução vira PR/push com sucesso (D-022): informa o cliente de que a
 * análise avançou e a mudança proposta está EM REVISÃO pela equipe — sem jargão,
 * sem prometer prazo e sem afirmar que algo já mudou em produção. Texto NEUTRO
 * quanto à natureza (serve a correção de problema E a alteração simples — D-023).
 */
export const MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO = [
  'Temos novidades: concluímos a análise e já preparamos uma proposta de mudança para o seu',
  'chamado. Ela está agora em revisão pela nossa equipe — nada muda no sistema até essa',
  'revisão ser aprovada e publicada. Avisaremos por aqui assim que houver uma posição.',
].join('\n');
