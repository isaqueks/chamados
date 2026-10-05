import {
  CLASSE_ESTADO_EXECUCAO,
  EstadoExecucao as EstadosExecucao,
  estadoLateral,
  valores,
  type EstadoExecucao,
  type MotivoEstado,
  type TipoEtapa,
} from '../../comum/estados';

/**
 * Máquina de estados PURA de `execucao` (specs/forja/03 §1, §2; 02 §2.1).
 *
 * POR QUE pura: "o app decide _se_ avança; o modelo decide _como_ trabalha"
 * (03 §1.1). Todo avanço é uma regra em código sobre fatos persistidos; este
 * módulo só recebe fatos (já calculados por `gates`, `ciclos`,
 * `regras-relatorio`…) e devolve a transição — quem grava o estado, o
 * `evento` e mexe em processo/git é o orquestrador. Assim a tabela de 03 §2.4
 * é testável por unidade linha a linha (critério de aceite 03 §12.1):
 * toda transição aceita com a condição verdadeira, recusada sem ela, e nada
 * fora da tabela.
 *
 * Três camadas:
 * 1. `TRANSICOES` — a tabela tipada (de, para, quem decide, motivos aceitos).
 * 2. `transicaoValida` / `aplicarTransicao` — confere uma transição contra a
 *    tabela e calcula `estado_anterior` (laterais, invariante I-9) e efeitos.
 * 3. `proximoEstado(atual, evento)` — o redutor: fato → transição, sempre
 *    passando pela camada 2 (um erro de mapeamento vira `recusado`, nunca um
 *    estado fora da tabela).
 */

// ---------------------------------------------------------------------------
// Classes de estado
// ---------------------------------------------------------------------------

/** Quem decide a transição (coluna "Decide" de 03 §2.4). */
export type AtorTransicao = 'codigo' | 'humano';

/** Origem gravada no `evento` da transição (03 §1.4). */
export type OrigemTransicao = 'codigo' | 'modelo' | 'humano';

/** Marcador de "volta para `estado_anterior`" (saída de lateral, 03 §2.3). */
export const ESTADO_ANTERIOR = 'estado_anterior' as const;
export type DestinoTransicao = EstadoExecucao | typeof ESTADO_ANTERIOR;

const TODOS: readonly EstadoExecucao[] = valores(EstadosExecucao);

export const ESTADOS_TERMINAIS: readonly EstadoExecucao[] = TODOS.filter(
  (e) => CLASSE_ESTADO_EXECUCAO[e] === 'terminal',
);
export const ESTADOS_LATERAIS: readonly EstadoExecucao[] = TODOS.filter(estadoLateral);

/** Depois de `mergeado` nada volta no pipeline; só sobra comunicação (03 §2.5). */
export const ESTADOS_POS_MERGE: readonly EstadoExecucao[] = [
  'mergeado',
  'comunicando',
  'mergeado_pendente_chamado',
  'aguardando_deploy',
];

/**
 * Não terminais anteriores a `mergeado`: onde valem Descartar/Encerrar (03 §2.1,
 * "Não desenhados"). Inclui `resolvendo_conflito` desde FJ-036.
 */
export const ESTADOS_ANTES_DE_MERGEADO: readonly EstadoExecucao[] = TODOS.filter(
  (e) => !ESTADOS_TERMINAIS.includes(e) && !ESTADOS_POS_MERGE.includes(e),
);

/** Antes de existir trabalho do condutor: IA do servidor ativa → `precisa_humano` (03 §11). */
export const ESTADOS_ANTES_DE_IMPLEMENTANDO: readonly EstadoExecucao[] = [
  'na_fila',
  'preparando',
  'planejando',
  'plano_pronto',
  'aguardando_plano',
  'aguardando_decisao',
  'aguardando_cliente_resposta',
];

/**
 * Estados com processo `claude` (turno de agente): pausa por cota, falha de saída (03 §2.3).
 * `resolvendo_conflito` (FJ-036): turno T1 de conflito na sessão condutora.
 */
export const ESTADOS_COM_AGENTE: readonly EstadoExecucao[] = [
  'planejando',
  'implementando',
  'revisando',
  'relatando',
  'resolvendo_conflito',
];

/**
 * Estados com algum passo em curso (agente, coleta, integração): crash → `interrompido`.
 * `verificando` é a coleta instantânea desde FJ-032 (sem processo); fica aqui
 * para Pausar/reboot tratarem igual a antes (a coleta é refeita).
 */
export const ESTADOS_COM_PROCESSO: readonly EstadoExecucao[] = [
  'preparando',
  ...ESTADOS_COM_AGENTE,
  'verificando',
  'integrando',
];

/** Pausar/Parar (03 §10; 06 §4.2): etapas com agente + verificação/integração (no fim do passo). */
export const ESTADOS_PAUSAVEIS: readonly EstadoExecucao[] = ESTADOS_COM_PROCESSO;

/** Assumir (03 §10) + `falhou` ("Tentar de novo; Assumir", 03 §11 saída inválida). */
export const ESTADOS_ASSUMIVEIS: readonly EstadoExecucao[] = [
  ...ESTADOS_COM_AGENTE,
  'pausado_usuario',
  'precisa_humano',
  'aguardando_aprovacao',
  'falhou',
];

export function estadoTerminal(estado: EstadoExecucao): boolean {
  return ESTADOS_TERMINAIS.includes(estado);
}

// ---------------------------------------------------------------------------
// Motivos (02 §2.2 `motivo_estado`, lista FECHADA)
// ---------------------------------------------------------------------------

/** Destinos que EXIGEM `motivo_estado` (02 §4.6: "por que está em precisa_humano/falhou/cancelado"). */
export const DESTINOS_COM_MOTIVO: readonly EstadoExecucao[] = [
  'precisa_humano',
  'falhou',
  'cancelado',
];

/** `falhou`: infraestrutura (02 §2.2, coluna "Uso"). `verificacao_ambiente` só em linhas antigas (FJ-032). */
export const MOTIVOS_FALHOU: readonly MotivoEstado[] = [
  'verificacao_ambiente',
  'setup_falhou',
  'saida_invalida',
  'perfil_divergente',
];

/**
 * Motivos que nenhuma transição escreve mais (FJ-032: a Forja não roda comandos
 * do projeto). Ficam na lista fechada só para as linhas antigas.
 */
export const MOTIVOS_OBSOLETOS: readonly MotivoEstado[] = ['base_vermelha', 'verificacao_ambiente'];

/** `cancelado`: Encerrar do humano ou chamado encerrado no servidor (02 §2.2). */
export const MOTIVOS_CANCELADO: readonly MotivoEstado[] = [
  'humano_encerrou',
  'chamado_mudou_no_servidor',
];

// ---------------------------------------------------------------------------
// Tabela (03 §2.4, §2.3, §6, §10, §11)
// ---------------------------------------------------------------------------

/** Efeitos que o orquestrador aplica junto com a transição (mesma transação). */
export interface EfeitosTransicao {
  /** `ciclo_auto += 1` (retrabalho revisão → T1, 03 §6). */
  ciclo_auto?: true;
  /** `ciclo_total += 1` (auto + ajustes + Devolver + reverificação reprovada + mais um ciclo, 03 §6). */
  ciclo_total?: true;
  /**
   * 1ª entrada em `implementando` (de `plano_pronto` ou G1): rodar `evidenciar
   * antes` se o plano prevê UI (03 §5.4) e tomar o token `schema` se
   * `plano.schema_banco.altera` (03 §7.3).
   */
  primeira_implementacao?: true;
}

export interface RegraTransicao {
  /** Estável, para teste e auditoria: `de>para` (ou nome da regra genérica). */
  id: string;
  de: readonly EstadoExecucao[];
  para: DestinoTransicao;
  atores: readonly AtorTransicao[];
  /** "Modelo produz, código valida": a origem gravada é `modelo` quando o código decide. */
  modelo_produz?: true;
  /** Motivos aceitos quando o destino leva motivo (`precisa_humano`/`falhou`/`cancelado`/`pausado_cota`). */
  motivos?: readonly MotivoEstado[];
  efeitos?: EfeitosTransicao;
  /** Condição exata, como na spec (documentação e mensagens de recusa). */
  condicao: string;
  ref: string;
}

const r = (regra: Omit<RegraTransicao, 'id'> & { id?: string }): RegraTransicao => ({
  id: regra.id ?? `${regra.de.join('|')}>${regra.para}`,
  ...regra,
});

export const TRANSICOES: readonly RegraTransicao[] = [
  // --- preparo e planejamento -------------------------------------------------
  r({
    de: ['na_fila'],
    para: 'preparando',
    atores: ['codigo'],
    condicao: 'vaga no semáforo ∧ freio de cota liberado ∧ ordem do lote ∧ CLI compatível',
    ref: '03 §2.4',
  }),
  r({
    de: ['preparando'],
    para: 'planejando',
    atores: ['codigo'],
    condicao: 'pré-condições ok ∧ worktree criada (sem setup nem linha de base, FJ-032)',
    ref: '03 §2.4, §4.1, §5.1',
  }),
  r({
    de: ['preparando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['chamado_mudou_no_servidor', 'ia_servidor_ativa', 'sentinela_divergente'],
    condicao: 'pré-condição falhou',
    ref: '03 §2.4, §2.5',
  }),
  r({
    de: ['planejando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['regra_conteudo_violada', 'timeout_etapa', 'orcamento_etapa', 'sentinela_divergente'],
    condicao:
      'plano recusado 2× (regras de conteúdo), timeout, error_max_budget_usd, teto por chamado',
    ref: '03 §2.4, §6',
  }),
  r({
    de: ['planejando'],
    para: 'plano_pronto',
    atores: ['codigo'],
    modelo_produz: true,
    condicao: 'último result sem erro ∧ plano.v1 válido ∧ regras de conteúdo ok (04 §6)',
    ref: '03 §2.4',
  }),
  r({
    de: ['plano_pronto'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['nao_implementavel'],
    condicao: 'natureza_confirmada = nao_implementavel',
    ref: '03 §2.4',
  }),
  r({
    de: ['plano_pronto'],
    para: 'aguardando_decisao',
    atores: ['codigo'],
    condicao: 'perguntas_ao_cliente ou decisoes_do_operador não vazio (precede G1)',
    ref: '03 §2.4',
  }),
  r({
    de: ['plano_pronto'],
    para: 'aguardando_plano',
    atores: ['codigo'],
    condicao: 'regra G1 dispara',
    ref: '03 §2.4, §4',
  }),
  r({
    de: ['plano_pronto'],
    para: 'implementando',
    atores: ['codigo'],
    efeitos: { primeira_implementacao: true },
    condicao: 'nenhuma das anteriores',
    ref: '03 §2.4, §5.4',
  }),
  r({
    de: ['aguardando_decisao'],
    para: 'aguardando_cliente_resposta',
    atores: ['humano'],
    condicao: 'aprova a pergunta (texto validado); app publica e move o chamado',
    ref: '03 §2.4',
  }),
  r({
    de: ['aguardando_decisao'],
    para: 'planejando',
    atores: ['humano'],
    condicao: 'responde as decisões (ou aceita a suposicao_padrao)',
    ref: '03 §2.4',
  }),
  r({
    de: ['preparando', 'planejando', 'aguardando_decisao', 'aguardando_cliente_resposta'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['transicao_recusada'],
    condicao:
      'Chamados recusou a transição (409/403) da rodada de início, da pergunta ou do Replanejar',
    ref: '03 §11',
  }),
  r({
    de: ['aguardando_cliente_resposta'],
    para: 'planejando',
    atores: ['humano'],
    condicao: 'cliente respondeu (polling) ∧ humano clica Replanejar',
    ref: '03 §2.4',
  }),
  r({
    de: ['aguardando_plano'],
    para: 'implementando',
    atores: ['humano'],
    efeitos: { primeira_implementacao: true },
    condicao: 'Aprovar (o plano editado vira o oficial)',
    ref: '03 §2.4, §7.4',
  }),
  r({
    de: ['aguardando_plano'],
    para: 'planejando',
    atores: ['humano'],
    condicao: 'Comentar: planejador retomado com o comentário',
    ref: '03 §2.4',
  }),
  // --- implementar, verificar, revisar, relatar ------------------------------
  r({
    de: ['implementando'],
    para: 'verificando',
    atores: ['codigo'],
    condicao: 'result sem erro ∧ resumo_impl.v1 válido ∧ commit do app ∧ diff não vazio',
    ref: '03 §2.4',
  }),
  r({
    de: ['implementando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['regra_conteudo_violada', 'timeout_etapa', 'orcamento_etapa', 'sentinela_divergente'],
    condicao: 'diff vazio, impedimento declarado, error_max_budget_usd, timeout, teto por chamado',
    ref: '03 §2.4, §6',
  }),
  // `verificando` = COLETA (FJ-032): sha verificado, selos, evidências e os
  // comandos do T1 lidos do stream. O app não executa comando do projeto: não
  // há "vermelho volta ao T1 sem revisor" nem falha de ambiente da verificação.
  r({
    de: ['verificando'],
    para: 'revisando',
    atores: ['codigo'],
    condicao: 'coleta concluída no sha_verificado = HEAD (evidências em qualquer resultado)',
    ref: '03 §2.4, §5',
  }),
  r({
    de: ['verificando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['sentinela_divergente'],
    condicao: 'sentinela divergente ou HEAD fora da branch da execução',
    ref: '03 §2.5',
  }),
  r({
    de: ['verificando'],
    para: 'falhou',
    atores: ['codigo'],
    motivos: ['setup_falhou'],
    condicao: 'erro inesperado na coleta (git/disco)',
    ref: '03 §11',
  }),
  r({
    de: ['revisando'],
    para: 'relatando',
    atores: ['codigo'],
    condicao:
      'aprovado ∧ 0 bloqueantes ∧ CA atendido/nao_verificavel ∧ HEAD == sha_verificado ∧ worktree limpa',
    ref: '03 §2.4; 04 §6',
  }),
  r({
    de: ['revisando'],
    para: 'implementando',
    atores: ['codigo'],
    efeitos: { ciclo_auto: true, ciclo_total: true },
    condicao: 'reprovado ∧ ciclo_auto < max_auto ∧ ciclo_total < max_total ∧ sem pingue-pongue',
    ref: '03 §2.4, §6',
  }),
  r({
    de: ['revisando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: [
      'ciclos_esgotados',
      'pingue_pongue',
      'regra_conteudo_violada',
      'timeout_etapa',
      'orcamento_etapa',
      'sentinela_divergente',
    ],
    condicao: 'limite, pingue-pongue, bloqueado/escalar, ou a revisão alterou a worktree',
    ref: '03 §2.4',
  }),
  r({
    de: ['relatando'],
    para: 'aguardando_aprovacao',
    atores: ['codigo'],
    condicao: 'relatorio.v1 válido ∧ coerente com os selos ∧ resposta ok ou marcada para G2',
    ref: '03 §2.4; 04 §6, §7.2',
  }),
  r({
    de: ['relatando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: [
      'relatorio_incoerente',
      'regra_conteudo_violada',
      'timeout_etapa',
      'orcamento_etapa',
      'sentinela_divergente',
    ],
    condicao: 'incoerência com os selos após 1 regeração',
    ref: '03 §2.4; 04 §7.2',
  }),
  // --- G2, retrabalho, fila de merge -----------------------------------------
  r({
    de: ['aguardando_aprovacao'],
    para: 'na_fila_merge',
    atores: ['humano'],
    condicao: 'Aprovar (FJ-034: sem exigências; avaliarG2 só confere dado velho e resposta)',
    ref: '03 §2.4, §4',
  }),
  r({
    de: ['aguardando_aprovacao'],
    para: 'retrabalho_humano',
    atores: ['humano'],
    condicao: 'Pedir ajustes com comentário',
    ref: '03 §2.4',
  }),
  r({
    de: ['retrabalho_humano'],
    para: 'implementando',
    atores: ['codigo'],
    efeitos: { ciclo_total: true },
    condicao: 'sempre; ciclo_total += 1 (não conta em ciclo_auto)',
    ref: '03 §2.4',
  }),
  r({
    de: ['na_fila_merge'],
    para: 'integrando',
    atores: ['codigo'],
    condicao: 'próximo da fila do destino ∧ semáforo merge livre',
    ref: '03 §2.4, §8',
  }),
  r({
    de: ['integrando'],
    para: 'mergeado',
    atores: ['codigo'],
    condicao:
      'integração limpa ∧ patch-id igual ∧ (destino sem interseção ∨ reverificação do revisor aprovada) ∧ ref avançada ∧ registrado',
    ref: '03 §2.4, §8.1',
  }),
  r({
    de: ['integrando'],
    para: 'aguardando_aprovacao',
    atores: ['codigo'],
    condicao: "patch-id integrado ≠ aprovado (G2')",
    ref: '03 §2.4, §8.1',
  }),
  r({
    de: ['integrando'],
    para: 'implementando',
    atores: ['codigo'],
    efeitos: { ciclo_total: true },
    condicao:
      'reverificação do revisor reprovada (FJ-032): destino integrado na branch, T1 com as instruções',
    ref: '03 §2.4, §8.1',
  }),
  r({
    de: ['integrando'],
    para: 'resolvendo_conflito',
    atores: ['codigo'],
    condicao:
      'conflito textual ∧ nenhum arquivo do detector `banco` ∧ até a 2ª resolução automática da execução (FJ-036)',
    ref: '03 §8.1, §8.4',
  }),
  r({
    de: ['integrando'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: [
      'conflito_merge',
      'conflito_schema',
      'schema_concorrente',
      'push_recusado',
      'sentinela_divergente',
    ],
    condicao:
      'conflito depois de 2 resoluções automáticas, conflito em migration/schema, schema concorrente sem reverificação possível, push recusado 3×, cópia local suja além da espera',
    ref: '03 §2.4, §7.3, §8.2, §8.4',
  }),
  r({
    de: ['integrando'],
    para: 'falhou',
    atores: ['codigo'],
    motivos: ['setup_falhou'],
    condicao: 'reverificação do revisor não concluiu, ou base/remoto da integração falhou',
    ref: '03 §8.1 passo 5',
  }),
  // --- resolução automática de conflito (FJ-036) ------------------------------
  r({
    de: ['resolvendo_conflito'],
    para: 'verificando',
    atores: ['codigo'],
    condicao:
      'turno de conflito concluído ∧ nenhum marcador de conflito ∧ merge do destino commitado pelo app',
    ref: '03 §8.4',
  }),
  r({
    de: ['resolvendo_conflito'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: [
      'conflito_merge',
      'conflito_schema',
      'regra_conteudo_violada',
      'timeout_etapa',
      'orcamento_etapa',
      'sentinela_divergente',
    ],
    condicao:
      'marcadores restantes após 1 correção, impedimento sem suposição, conflito em migration/schema, timeout, orçamento',
    ref: '03 §8.4',
  }),
  // --- pós-merge (outbox) -----------------------------------------------------
  r({
    de: ['mergeado'],
    para: 'comunicando',
    atores: ['codigo'],
    condicao: 'sempre',
    ref: '03 §2.4',
  }),
  r({
    de: ['comunicando'],
    para: 'aguardando_deploy',
    atores: ['codigo'],
    condicao: 'ao_concluir = aguardar_deploy ∧ passo nota_interna feito',
    ref: '03 §2.4, §9.4',
  }),
  r({
    de: ['aguardando_deploy'],
    para: 'comunicando',
    atores: ['humano'],
    condicao: 'Gdeploy "Publicado em produção"',
    ref: '03 §2.4, §4',
  }),
  r({
    de: ['comunicando'],
    para: 'mergeado_pendente_chamado',
    atores: ['codigo'],
    condicao: 'passo falhou por rede, 5xx ou 401 após relogin',
    ref: '03 §2.4, §9.3',
  }),
  r({
    de: ['mergeado_pendente_chamado'],
    para: 'comunicando',
    atores: ['codigo', 'humano'],
    condicao: 'próxima tentativa do backoff ou "tentar agora"',
    ref: '03 §2.4',
  }),
  r({
    de: ['comunicando'],
    para: 'concluido',
    atores: ['codigo'],
    condicao: 'todos os passos enviado ou pulado',
    ref: '03 §2.4',
  }),
  // --- precisa_humano: ações conforme o motivo -------------------------------
  r({
    de: ['precisa_humano'],
    para: 'implementando',
    atores: ['humano'],
    efeitos: { ciclo_total: true },
    condicao: 'mais um ciclo com instrução (acima de max_total exige confirmação)',
    ref: '03 §2.4, §6',
  }),
  r({
    de: ['precisa_humano'],
    para: 'relatando',
    atores: ['humano'],
    condicao: 'seguir com achados abertos',
    ref: '03 §2.4',
  }),
  r({
    de: ['precisa_humano'],
    para: 'planejando',
    atores: ['humano'],
    condicao: 'replanejar, só antes de existir commit',
    ref: '03 §2.4, §3.1',
  }),
  r({
    de: ['precisa_humano'],
    para: 'aguardando_aprovacao',
    atores: ['humano'],
    condicao: 'relatorio_incoerente: humano edita o relatório (o app registra a edição)',
    ref: '03 §11',
  }),
  r({
    de: ['precisa_humano'],
    para: 'na_fila_merge',
    atores: ['humano'],
    condicao: 'push_recusado: "tentar de novo mais tarde" com a aprovação ainda vigente',
    ref: '03 §11',
  }),
  // "Tentar de novo" volta ao começo da ETAPA que parou (pedido do usuário,
  // 2026-10-03): revisão/relatório estourados não refazem a implementação.
  r({
    de: ['precisa_humano'],
    para: 'verificando',
    atores: ['humano'],
    condicao: 'tentar de novo após falha na coleta/verificação',
    ref: 'FJ-032',
  }),
  r({
    de: ['precisa_humano'],
    para: 'revisando',
    atores: ['humano'],
    condicao: 'tentar de novo após falha na revisão (timeout/orçamento/saída inválida)',
    ref: 'FJ-032',
  }),
  r({
    de: ['precisa_humano'],
    para: 'resolvendo_conflito',
    atores: ['humano'],
    condicao:
      'tentar de novo com conflito_merge (ou parado no turno de conflito): o agente resolve',
    ref: 'FJ-036; 03 §8.4',
  }),
  // --- genéricas (03 §2.1 "Não desenhados"; §11 polling) ----------------------
  r({
    id: 'descartar',
    de: ESTADOS_ANTES_DE_MERGEADO,
    para: 'descartado',
    atores: ['humano'],
    condicao: 'Descartar (nota interna opcional); nunca depois de mergeado',
    ref: '03 §2.1, §2.4',
  }),
  r({
    id: 'encerrar',
    de: ESTADOS_ANTES_DE_MERGEADO,
    para: 'cancelado',
    atores: ['humano'],
    motivos: MOTIVOS_CANCELADO,
    condicao: 'Encerrar/Desistir',
    ref: '03 §2.1, §2.4',
  }),
  r({
    id: 'chamado_mudou_no_servidor',
    de: ESTADOS_ANTES_DE_MERGEADO.filter((e) => e !== 'assumido_manual' && e !== 'precisa_humano'),
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['chamado_mudou_no_servidor'],
    condicao: 'polling: chamado cancelado/fechado/reaberto por fora antes de mergeado',
    ref: '03 §11',
  }),
  r({
    id: 'ia_servidor_ativa',
    de: ESTADOS_ANTES_DE_IMPLEMENTANDO,
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['ia_servidor_ativa'],
    // FJ-031: o orquestrador não emite mais (sinais da IA do servidor são só
    // informativos); a transição fica para `motivo_estado` de linhas antigas.
    condicao: 'legado (FJ-031): não emitido; sinais da IA do servidor são informativos',
    ref: '03 §11',
  }),
  // --- laterais (03 §2.3, §10) -------------------------------------------------
  r({
    id: 'pausar',
    de: ESTADOS_PAUSAVEIS,
    para: 'pausado_usuario',
    atores: ['humano'],
    condicao: 'Pausar/Parar (verificação e integração: no fim do passo corrente)',
    ref: '03 §2.3, §10',
  }),
  r({
    id: 'retomar_pausa',
    de: ['pausado_usuario'],
    para: ESTADO_ANTERIOR,
    atores: ['humano'],
    condicao: 'Retomar',
    ref: '03 §2.3',
  }),
  r({
    id: 'limite_cota',
    de: ESTADOS_COM_AGENTE,
    para: 'pausado_cota',
    atores: ['codigo'],
    motivos: ['cota_overage'],
    condicao: 'etapa falhou por limite da assinatura ou overage não autorizado',
    ref: '03 §2.3, §7.6',
  }),
  r({
    id: 'cota_liberada',
    de: ['pausado_cota'],
    para: ESTADO_ANTERIOR,
    atores: ['codigo', 'humano'],
    condicao: 'resetsAt passou (automático) ou "retomar agora" com créditos extras autorizados',
    ref: '03 §2.3, §7.6; 06 §4.2',
  }),
  r({
    id: 'assumir',
    de: ESTADOS_ASSUMIVEIS,
    para: 'assumido_manual',
    atores: ['humano'],
    condicao: 'Assumir (PTY com --resume da sessão)',
    ref: '03 §2.3, §10',
  }),
  r({
    id: 'devolver',
    de: ['assumido_manual'],
    para: 'verificando',
    atores: ['humano'],
    efeitos: { ciclo_total: true },
    condicao: 'Devolver com o PTY fechado; commit do app; ciclo_total += 1',
    ref: '03 §2.3, §10',
  }),
  r({
    id: 'interromper',
    de: ESTADOS_COM_PROCESSO,
    para: 'interrompido',
    atores: ['codigo'],
    condicao: 'processo morreu sem result sem ter sido pedido (timeout não é interrupção)',
    ref: '03 §2.3, §11',
  }),
  r({
    id: 'retomar_interrompido',
    de: ['interrompido'],
    para: ESTADO_ANTERIOR,
    atores: ['codigo', 'humano'],
    condicao: 'retomada da etapa (automática 1× ou manual)',
    ref: '03 §2.3, §3.3',
  }),
  r({
    de: ['interrompido'],
    para: 'precisa_humano',
    atores: ['codigo'],
    motivos: ['segunda_interrupcao'],
    condicao: 'segunda interrupção na mesma etapa',
    ref: '03 §3.3',
  }),
  r({
    id: 'falha_infra',
    // `plano_pronto`/`retrabalho_humano`: passos transitórios do app; um erro
    // interno neles não pode virar retentativa silenciosa (03 §11).
    de: ['preparando', 'plano_pronto', 'retrabalho_humano', ...ESTADOS_COM_AGENTE],
    para: 'falhou',
    atores: ['codigo'],
    motivos: ['setup_falhou', 'saida_invalida', 'perfil_divergente'],
    condicao: 'spawn, git, setup, CLI incompatível, saída inválida após 1 nova tentativa',
    ref: '03 §2.3, §6',
  }),
  r({
    id: 'tentar_de_novo',
    de: ['falhou'],
    para: ESTADO_ANTERIOR,
    atores: ['humano'],
    condicao: 'Tentar de novo (início da etapa)',
    ref: '03 §2.3',
  }),
];

// ---------------------------------------------------------------------------
// Validação de uma transição
// ---------------------------------------------------------------------------

export interface OpcoesTransicao {
  /** Obrigatório para sair de lateral por `ESTADO_ANTERIOR` (I-9). */
  estado_anterior?: EstadoExecucao | null;
  motivo?: MotivoEstado | null;
}

export type ResultadoValidacaoTransicao =
  | { valida: true; regras: RegraTransicao[]; origem: OrigemTransicao }
  | { valida: false; erro: string };

function destinoResolvido(regra: RegraTransicao, anterior: EstadoExecucao | null | undefined) {
  return regra.para === ESTADO_ANTERIOR ? (anterior ?? null) : regra.para;
}

/**
 * A transição `estado → para` decidida por `ator` está na tabela? Confere
 * também o motivo (obrigatório e da lista certa em `precisa_humano`/`falhou`/
 * `cancelado`; proibido onde a spec não o prevê) e o `estado_anterior` das
 * saídas de lateral.
 */
export function transicaoValida(
  estado: EstadoExecucao,
  para: EstadoExecucao,
  ator: AtorTransicao,
  opcoes: OpcoesTransicao = {},
): ResultadoValidacaoTransicao {
  if (estadoTerminal(estado)) return { valida: false, erro: `"${estado}" é terminal` };
  if (para === estado) return { valida: false, erro: `"${estado}" → "${para}" não é transição` };
  const anterior = opcoes.estado_anterior ?? null;
  if (estadoLateral(estado) && anterior === null) {
    return { valida: false, erro: `lateral "${estado}" sem estado_anterior (I-9)` };
  }
  if (anterior !== null && (estadoLateral(anterior) || estadoTerminal(anterior))) {
    return { valida: false, erro: `estado_anterior "${anterior}" inválido` };
  }

  const porDestino = TRANSICOES.filter(
    (t) => t.de.includes(estado) && destinoResolvido(t, anterior) === para,
  );
  if (porDestino.length === 0) {
    return { valida: false, erro: `"${estado}" → "${para}" está fora da tabela (03 §2.4)` };
  }
  const porAtor = porDestino.filter((t) => t.atores.includes(ator));
  if (porAtor.length === 0) {
    const quem = [...new Set(porDestino.flatMap((t) => t.atores))].join('/');
    return { valida: false, erro: `"${estado}" → "${para}" é decidida por ${quem}, não ${ator}` };
  }

  const motivo = opcoes.motivo ?? null;
  const aceitos = porAtor.flatMap((t) => t.motivos ?? []);
  if (DESTINOS_COM_MOTIVO.includes(para)) {
    if (motivo === null) return { valida: false, erro: `"${para}" exige motivo_estado` };
    if (!aceitos.includes(motivo)) {
      return { valida: false, erro: `motivo "${motivo}" não vale para "${estado}" → "${para}"` };
    }
  } else if (motivo !== null && !aceitos.includes(motivo)) {
    return { valida: false, erro: `"${estado}" → "${para}" não leva motivo "${motivo}"` };
  }

  const origem: OrigemTransicao =
    ator === 'humano' ? 'humano' : porAtor.some((t) => t.modelo_produz) ? 'modelo' : 'codigo';
  return { valida: true, regras: porAtor, origem };
}

/** Destinos possíveis a partir de um estado (com `ESTADO_ANTERIOR` resolvido). */
export function destinosPossiveis(
  estado: EstadoExecucao,
  estadoAnterior: EstadoExecucao | null = null,
): EstadoExecucao[] {
  if (estadoTerminal(estado)) return [];
  const destinos = TRANSICOES.filter((t) => t.de.includes(estado))
    .map((t) => destinoResolvido(t, estadoAnterior))
    .filter((d): d is EstadoExecucao => d !== null && d !== estado);
  return [...new Set(destinos)];
}

// ---------------------------------------------------------------------------
// Aplicação: novo estado + estado_anterior + efeitos
// ---------------------------------------------------------------------------

/** O que o orquestrador precisa saber da execução para decidir (subconjunto de `execucao`). */
export interface EstadoAtualExecucao {
  estado: EstadoExecucao;
  estado_anterior: EstadoExecucao | null;
  motivo_estado?: MotivoEstado | null;
}

export interface EfeitosAplicados {
  ciclo_auto: 0 | 1;
  ciclo_total: 0 | 1;
  primeira_implementacao: boolean;
  /** Token `schema` é solto em `mergeado`/`descartado`/`cancelado`, nunca em `precisa_humano` (03 §7.3). */
  solta_token_schema: boolean;
}

export interface TransicaoAplicada {
  de: EstadoExecucao;
  para: EstadoExecucao;
  ator: AtorTransicao;
  origem: OrigemTransicao;
  estado_anterior: EstadoExecucao | null;
  motivo_estado: MotivoEstado | null;
  motivo_texto: string | null;
  regra: string;
  efeitos: EfeitosAplicados;
}

export type ResultadoAplicacao =
  { ok: true; transicao: TransicaoAplicada } | { ok: false; erro: string };

export const ESTADOS_QUE_SOLTAM_SCHEMA: readonly EstadoExecucao[] = [
  'mergeado',
  'descartado',
  'cancelado',
];

export function aplicarTransicao(
  atual: EstadoAtualExecucao,
  para: EstadoExecucao,
  ator: AtorTransicao,
  opcoes: { motivo?: MotivoEstado | null; motivo_texto?: string | null } = {},
): ResultadoAplicacao {
  const motivo = opcoes.motivo ?? null;
  const v = transicaoValida(atual.estado, para, ator, {
    estado_anterior: atual.estado_anterior,
    motivo,
  });
  if (!v.valida) return { ok: false, erro: v.erro };

  // Lateral → lateral preserva o anterior original (ex.: pausado → assumido).
  const estadoAnterior = estadoLateral(para)
    ? estadoLateral(atual.estado)
      ? atual.estado_anterior
      : atual.estado
    : null;
  const efeitos = v.regras.reduce<EfeitosTransicao>((acc, t) => ({ ...acc, ...t.efeitos }), {});
  return {
    ok: true,
    transicao: {
      de: atual.estado,
      para,
      ator,
      origem: v.origem,
      estado_anterior: estadoAnterior,
      motivo_estado: motivo,
      motivo_texto: motivo === null ? null : (opcoes.motivo_texto ?? null),
      regra: v.regras.map((t) => t.id).join(' + '),
      efeitos: {
        ciclo_auto: efeitos.ciclo_auto ? 1 : 0,
        ciclo_total: efeitos.ciclo_total ? 1 : 0,
        primeira_implementacao: efeitos.primeira_implementacao === true,
        solta_token_schema: ESTADOS_QUE_SOLTAM_SCHEMA.includes(para),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Redutor: fato → transição
// ---------------------------------------------------------------------------

/** Decisão já tomada por `gates`/`ciclos`/`regras-relatorio` que vira transição aqui. */
export interface DecisaoDestino {
  para: EstadoExecucao;
  motivo?: MotivoEstado | null;
  texto?: string | null;
}

/** Resultado da integração (03 §8.1/§8.2), calculado pelo passo da fila de merge. */
export type ResultadoIntegracao =
  | 'mergeado'
  | 'patch_id_mudou'
  /** O revisor reprovou o resultado integrado (destino andou ∧ interseção, FJ-032). */
  | 'reverificacao_vermelha'
  /** O turno de reverificação do revisor não concluiu (timeout, orçamento, saída…). */
  | 'reverificacao_falhou'
  | 'setup_falhou'
  | 'conflito'
  | 'conflito_schema'
  /** Schema concorrente (03 §7.3) que a reverificação obrigatória não consegue resolver. */
  | 'schema_concorrente'
  | 'push_recusado_3x'
  | 'copia_suja_expirou'
  /** CAS recusado / push não-ff (< 3): volta ao passo 1 sem mudar de estado. */
  | 'recomecar'
  /** Conflito que o agente resolve (FJ-036): → `resolvendo_conflito`. */
  | 'resolver_conflito';

export type EventoMaquina =
  // ---- código ----
  | {
      tipo: 'tentar_iniciar';
      vaga_livre: boolean;
      freio_liberado: boolean;
      ordem_lote_ok: boolean;
      cli_compativel: boolean;
    }
  | {
      tipo: 'preparo_concluido';
      pre_condicoes:
        | { ok: true }
        | { ok: false; motivo: 'chamado_mudou_no_servidor' | 'ia_servidor_ativa'; texto?: string };
      worktree_ok: boolean;
      texto?: string;
    }
  | {
      tipo: 'plano_produzido';
      result_sem_erro: boolean;
      contrato_valido: boolean;
      regras_ok: boolean;
    }
  | { tipo: 'plano_avaliado'; decisao: DecisaoDestino }
  | {
      tipo: 'implementacao_concluida';
      result_sem_erro: boolean;
      contrato_valido: boolean;
      commit_feito: boolean;
      diff_vazio: boolean;
      bloqueios: readonly string[];
    }
  | { tipo: 'verificacao_concluida'; decisao: DecisaoDestino }
  | { tipo: 'veredito_avaliado'; decisao: DecisaoDestino }
  | { tipo: 'relatorio_avaliado'; decisao: DecisaoDestino }
  | { tipo: 'retrabalho_iniciado' }
  | {
      tipo: 'vez_na_fila_merge';
      proximo_da_fila: boolean;
      semaforo_merge_livre: boolean;
      /** Sentinela não reconhecida trava a fila do projeto (03 §2.5). */
      fila_travada?: boolean;
    }
  | { tipo: 'integracao_concluida'; resultado: ResultadoIntegracao; texto?: string }
  | {
      /** Fim do turno T1 de conflito (FJ-036). */
      tipo: 'conflito_resolvido';
      resultado: 'resolvido' | 'conflito_merge' | 'conflito_schema' | 'impedimento';
      texto?: string;
    }
  | { tipo: 'outbox_iniciado' }
  | {
      tipo: 'outbox_avancou';
      resultado: 'concluido' | 'aguardar_deploy' | 'falha_retentavel' | 'em_andamento';
    }
  | { tipo: 'outbox_retentar' }
  | { tipo: 'processo_interrompido' }
  | { tipo: 'retomada_automatica'; ja_retomada_nesta_etapa: boolean }
  | { tipo: 'limite_cota'; overage_nao_autorizado: boolean }
  | { tipo: 'cota_liberada' }
  | {
      tipo: 'falha_infra';
      motivo: 'setup_falhou' | 'saida_invalida' | 'perfil_divergente';
      texto?: string;
    }
  | { tipo: 'etapa_estourou'; causa: 'timeout' | 'orcamento' | 'teto_chamado' }
  | { tipo: 'regra_conteudo_persistente'; erros: readonly string[] }
  | { tipo: 'sentinela_divergente'; caminhos: readonly string[] }
  | { tipo: 'chamado_mudou_no_servidor'; texto?: string }
  | { tipo: 'ia_servidor_ativa'; texto?: string }
  | { tipo: 'transicao_recusada'; texto?: string }
  // ---- humano ----
  | { tipo: 'aprovar_plano' }
  | { tipo: 'comentar_plano' }
  | { tipo: 'perguntar_cliente'; texto_valido: boolean }
  | { tipo: 'operador_decidiu' }
  | { tipo: 'replanejar'; cliente_respondeu?: boolean; existe_commit?: boolean }
  | { tipo: 'aprovar_final'; exigencias_ok: boolean }
  | { tipo: 'pedir_ajustes'; comentario: string }
  | { tipo: 'assumir' }
  | { tipo: 'devolver'; pty_fechado: boolean }
  | { tipo: 'pausar' }
  | { tipo: 'retomar'; creditos_extras_autorizados?: boolean }
  | { tipo: 'tentar_novamente'; existe_commit?: boolean; etapa_anterior?: TipoEtapa | null }
  | { tipo: 'mais_um_ciclo'; exige_confirmacao: boolean; confirmado: boolean }
  | { tipo: 'seguir_com_achados' }
  | { tipo: 'editar_relatorio' }
  | { tipo: 'tentar_merge_de_novo'; aprovacao_vigente: boolean }
  | { tipo: 'encerrar' }
  | { tipo: 'descartar' }
  | { tipo: 'publicado_producao' };

export type TipoEventoMaquina = EventoMaquina['tipo'];

export type DecisaoMaquina =
  | { tipo: 'transicao'; transicao: TransicaoAplicada }
  /** O fato não muda o estado (espera vaga, passo intermediário…). */
  | { tipo: 'permanece'; razao: string }
  /** O fato não vale neste estado ou a condição da tabela não foi satisfeita. */
  | { tipo: 'recusado'; erro: string };

const permanece = (razao: string): DecisaoMaquina => ({ tipo: 'permanece', razao });
const recusado = (erro: string): DecisaoMaquina => ({ tipo: 'recusado', erro });

function ir(
  atual: EstadoAtualExecucao,
  para: EstadoExecucao,
  ator: AtorTransicao,
  motivo: MotivoEstado | null = null,
  texto: string | null = null,
): DecisaoMaquina {
  const a = aplicarTransicao(atual, para, ator, { motivo, motivo_texto: texto });
  return a.ok ? { tipo: 'transicao', transicao: a.transicao } : recusado(a.erro);
}

/** Bloqueio que exige humano: o agente escreveu "sem suposição"/"sem recomendação" (sem acento também). */
export function semSuposicao(bloqueio: string): boolean {
  const texto = bloqueio
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /(^|:\s*)sem (suposicao|recomendacao)\b/.test(texto);
}

function voltar(atual: EstadoAtualExecucao, ator: AtorTransicao): DecisaoMaquina {
  if (!atual.estado_anterior) return recusado(`"${atual.estado}" sem estado_anterior (I-9)`);
  return ir(atual, atual.estado_anterior, ator);
}

function exigir(atual: EstadoAtualExecucao, ...estados: EstadoExecucao[]): string | null {
  return estados.includes(atual.estado)
    ? null
    : `fato não vale em "${atual.estado}" (esperado: ${estados.join(', ')})`;
}

const TEXTO_ESTOURO: Record<'timeout' | 'orcamento' | 'teto_chamado', string> = {
  timeout: 'tempo esgotado na etapa',
  orcamento: 'orçamento da etapa esgotado (error_max_budget_usd)',
  teto_chamado: 'teto de custo por chamado atingido: nenhuma etapa nova começa',
};

/**
 * Redutor da máquina: dado o estado atual e um FATO (código) ou uma AÇÃO
 * (humano), devolve a transição validada contra a tabela, `permanece` ou
 * `recusado`. Nunca devolve uma transição fora de `TRANSICOES`.
 */
export function proximoEstado(atual: EstadoAtualExecucao, evento: EventoMaquina): DecisaoMaquina {
  if (estadoTerminal(atual.estado)) return recusado(`"${atual.estado}" é terminal`);
  let erro: string | null;
  switch (evento.tipo) {
    // ---------------------------------------------------------------- código
    case 'tentar_iniciar': {
      if ((erro = exigir(atual, 'na_fila'))) return recusado(erro);
      const faltam = [
        !evento.vaga_livre && 'vaga',
        !evento.freio_liberado && 'freio de cota',
        !evento.ordem_lote_ok && 'ordem do lote',
        !evento.cli_compativel && 'CLI compatível',
      ].filter((x): x is string => typeof x === 'string');
      return faltam.length > 0
        ? permanece(`aguardando: ${faltam.join(', ')}`)
        : ir(atual, 'preparando', 'codigo');
    }
    case 'preparo_concluido': {
      if ((erro = exigir(atual, 'preparando'))) return recusado(erro);
      const pc = evento.pre_condicoes;
      if (!pc.ok) return ir(atual, 'precisa_humano', 'codigo', pc.motivo, pc.texto ?? null);
      if (!evento.worktree_ok) {
        return ir(atual, 'falhou', 'codigo', 'setup_falhou', evento.texto ?? null);
      }
      return ir(atual, 'planejando', 'codigo');
    }
    case 'plano_produzido': {
      if ((erro = exigir(atual, 'planejando'))) return recusado(erro);
      if (!evento.result_sem_erro || !evento.contrato_valido || !evento.regras_ok) {
        return recusado('plano sem result válido ou com regra violada: use decidirRecusa/saída');
      }
      return ir(atual, 'plano_pronto', 'codigo');
    }
    case 'plano_avaliado':
      if ((erro = exigir(atual, 'plano_pronto'))) return recusado(erro);
      return irDecisao(atual, evento.decisao);
    case 'implementacao_concluida': {
      if ((erro = exigir(atual, 'implementando'))) return recusado(erro);
      if (!evento.result_sem_erro || !evento.contrato_valido) {
        return recusado('T1 sem result válido: use decidirSaidaInvalida/decidirRecusa');
      }
      // Limitações de AMBIENTE (submódulo ausente, sem .env, erro pré-existente
      // numa dependência) não param o pipeline: vão ao revisor e ao relatório.
      // Só o que exige um humano decidir (decisão do operador, informação do
      // cliente, arquivo fora do plano) leva a `precisa_humano`. Caso real do
      // chamado #56 (2026-10-03).
      // FJ-033 estendida ao T1 (pedido do usuário, 2026-10-03, chamado #56:
      // "quadro passa de 1124 para 1244px… decidir se aceita"): o implementador
      // DECIDE e registra; só para quando declara explicitamente que não há
      // suposição razoável. Os demais bloqueios viram suposições no relatório.
      const bloqueiosHumanos = evento.bloqueios.filter((b) => semSuposicao(b));
      if (bloqueiosHumanos.length > 0) {
        return ir(
          atual,
          'precisa_humano',
          'codigo',
          'regra_conteudo_violada',
          `impedimento declarado: ${bloqueiosHumanos.join('; ')}`,
        );
      }
      if (evento.diff_vazio) {
        return ir(
          atual,
          'precisa_humano',
          'codigo',
          'regra_conteudo_violada',
          'o turno terminou sem alteração (diff vazio)',
        );
      }
      if (!evento.commit_feito) return recusado('o app ainda não commitou o turno');
      return ir(atual, 'verificando', 'codigo');
    }
    case 'verificacao_concluida':
      if ((erro = exigir(atual, 'verificando'))) return recusado(erro);
      return irDecisao(atual, evento.decisao);
    case 'veredito_avaliado':
      if ((erro = exigir(atual, 'revisando'))) return recusado(erro);
      return irDecisao(atual, evento.decisao);
    case 'relatorio_avaliado':
      if ((erro = exigir(atual, 'relatando'))) return recusado(erro);
      return irDecisao(atual, evento.decisao);
    case 'retrabalho_iniciado':
      if ((erro = exigir(atual, 'retrabalho_humano'))) return recusado(erro);
      return ir(atual, 'implementando', 'codigo');
    case 'vez_na_fila_merge': {
      if ((erro = exigir(atual, 'na_fila_merge'))) return recusado(erro);
      if (evento.fila_travada) return permanece('fila do projeto travada pela sentinela');
      if (!evento.proximo_da_fila) return permanece('não é o próximo da fila do destino');
      if (!evento.semaforo_merge_livre) return permanece('semáforo merge ocupado');
      return ir(atual, 'integrando', 'codigo');
    }
    case 'integracao_concluida': {
      if ((erro = exigir(atual, 'integrando'))) return recusado(erro);
      const t = evento.texto ?? null;
      switch (evento.resultado) {
        case 'mergeado':
          return ir(atual, 'mergeado', 'codigo');
        case 'patch_id_mudou':
          return ir(atual, 'aguardando_aprovacao', 'codigo');
        case 'reverificacao_vermelha':
          return ir(atual, 'implementando', 'codigo');
        case 'reverificacao_falhou':
          return ir(atual, 'falhou', 'codigo', 'setup_falhou', t);
        case 'setup_falhou':
          return ir(atual, 'falhou', 'codigo', 'setup_falhou', t);
        case 'conflito':
          return ir(atual, 'precisa_humano', 'codigo', 'conflito_merge', t);
        case 'conflito_schema':
          return ir(atual, 'precisa_humano', 'codigo', 'conflito_schema', t);
        case 'schema_concorrente':
          return ir(atual, 'precisa_humano', 'codigo', 'schema_concorrente', t);
        case 'push_recusado_3x':
          return ir(atual, 'precisa_humano', 'codigo', 'push_recusado', t ?? 'push recusado 3×');
        case 'copia_suja_expirou':
          return ir(
            atual,
            'precisa_humano',
            'codigo',
            'push_recusado',
            t ?? 'cópia local suja além do tempo de espera (merge_local)',
          );
        case 'recomecar':
          return permanece('ref andou: recomeça do passo 1 da integração');
        case 'resolver_conflito':
          return ir(atual, 'resolvendo_conflito', 'codigo');
      }
      return recusado('resultado de integração desconhecido');
    }
    case 'conflito_resolvido': {
      if ((erro = exigir(atual, 'resolvendo_conflito'))) return recusado(erro);
      const t = evento.texto ?? null;
      switch (evento.resultado) {
        case 'resolvido':
          return ir(atual, 'verificando', 'codigo');
        case 'conflito_merge':
          return ir(atual, 'precisa_humano', 'codigo', 'conflito_merge', t);
        case 'conflito_schema':
          return ir(atual, 'precisa_humano', 'codigo', 'conflito_schema', t);
        case 'impedimento':
          return ir(atual, 'precisa_humano', 'codigo', 'regra_conteudo_violada', t);
      }
      return recusado('resultado de conflito desconhecido');
    }
    case 'outbox_iniciado':
      if ((erro = exigir(atual, 'mergeado'))) return recusado(erro);
      return ir(atual, 'comunicando', 'codigo');
    case 'outbox_avancou': {
      if ((erro = exigir(atual, 'comunicando'))) return recusado(erro);
      switch (evento.resultado) {
        case 'concluido':
          return ir(atual, 'concluido', 'codigo');
        case 'aguardar_deploy':
          return ir(atual, 'aguardando_deploy', 'codigo');
        case 'falha_retentavel':
          return ir(atual, 'mergeado_pendente_chamado', 'codigo');
        case 'em_andamento':
          return permanece('outbox em andamento');
      }
      return recusado('resultado de outbox desconhecido');
    }
    case 'outbox_retentar':
      if ((erro = exigir(atual, 'mergeado_pendente_chamado'))) return recusado(erro);
      return ir(atual, 'comunicando', 'codigo');
    case 'processo_interrompido':
      if ((erro = exigir(atual, ...ESTADOS_COM_PROCESSO))) return recusado(erro);
      return ir(atual, 'interrompido', 'codigo');
    case 'retomada_automatica':
      if ((erro = exigir(atual, 'interrompido'))) return recusado(erro);
      return evento.ja_retomada_nesta_etapa
        ? ir(atual, 'precisa_humano', 'codigo', 'segunda_interrupcao')
        : voltar(atual, 'codigo');
    case 'limite_cota':
      if ((erro = exigir(atual, ...ESTADOS_COM_AGENTE))) return recusado(erro);
      return ir(
        atual,
        'pausado_cota',
        'codigo',
        evento.overage_nao_autorizado ? 'cota_overage' : null,
      );
    case 'cota_liberada':
      if ((erro = exigir(atual, 'pausado_cota'))) return recusado(erro);
      return voltar(atual, 'codigo');
    case 'falha_infra':
      return ir(atual, 'falhou', 'codigo', evento.motivo, evento.texto ?? null);
    case 'etapa_estourou':
      return ir(
        atual,
        'precisa_humano',
        'codigo',
        evento.causa === 'timeout' ? 'timeout_etapa' : 'orcamento_etapa',
        TEXTO_ESTOURO[evento.causa],
      );
    case 'regra_conteudo_persistente':
      return ir(
        atual,
        'precisa_humano',
        'codigo',
        'regra_conteudo_violada',
        evento.erros.join('; ') || null,
      );
    case 'sentinela_divergente':
      return ir(
        atual,
        'precisa_humano',
        'codigo',
        'sentinela_divergente',
        evento.caminhos.join(', ') || null,
      );
    case 'chamado_mudou_no_servidor':
      if (!ESTADOS_ANTES_DE_MERGEADO.includes(atual.estado)) {
        return permanece('depois do merge o outbox trata (03 §9.3)');
      }
      return ir(
        atual,
        'precisa_humano',
        'codigo',
        'chamado_mudou_no_servidor',
        evento.texto ?? null,
      );
    case 'ia_servidor_ativa':
      if (!ESTADOS_ANTES_DE_IMPLEMENTANDO.includes(atual.estado)) {
        return permanece('depois de implementando vira alerta em G2 (03 §11)');
      }
      return ir(atual, 'precisa_humano', 'codigo', 'ia_servidor_ativa', evento.texto ?? null);
    case 'transicao_recusada':
      return ir(atual, 'precisa_humano', 'codigo', 'transicao_recusada', evento.texto ?? null);

    // ---------------------------------------------------------------- humano
    case 'aprovar_plano':
      if ((erro = exigir(atual, 'aguardando_plano'))) return recusado(erro);
      return ir(atual, 'implementando', 'humano');
    case 'comentar_plano':
      if ((erro = exigir(atual, 'aguardando_plano'))) return recusado(erro);
      return ir(atual, 'planejando', 'humano');
    case 'perguntar_cliente':
      if ((erro = exigir(atual, 'aguardando_decisao'))) return recusado(erro);
      if (!evento.texto_valido) return recusado('texto da pergunta não passou no validador');
      return ir(atual, 'aguardando_cliente_resposta', 'humano');
    case 'operador_decidiu':
      if ((erro = exigir(atual, 'aguardando_decisao'))) return recusado(erro);
      return ir(atual, 'planejando', 'humano');
    case 'replanejar':
      if (atual.estado === 'aguardando_cliente_resposta') {
        return evento.cliente_respondeu
          ? ir(atual, 'planejando', 'humano')
          : recusado('o cliente ainda não respondeu');
      }
      if (atual.estado === 'precisa_humano') {
        return evento.existe_commit === false
          ? ir(atual, 'planejando', 'humano')
          : recusado('replanejar só antes de existir commit (03 §3.1)');
      }
      return recusado(`replanejar não vale em "${atual.estado}"`);
    case 'aprovar_final':
      if ((erro = exigir(atual, 'aguardando_aprovacao'))) return recusado(erro);
      if (!evento.exigencias_ok)
        return recusado('avaliarG2 recusou (dado velho ou resposta inválida)');
      return ir(atual, 'na_fila_merge', 'humano');
    case 'pedir_ajustes':
      if ((erro = exigir(atual, 'aguardando_aprovacao'))) return recusado(erro);
      if (evento.comentario.trim().length === 0) return recusado('comentário obrigatório');
      return ir(atual, 'retrabalho_humano', 'humano');
    case 'assumir':
      return ir(atual, 'assumido_manual', 'humano');
    case 'devolver':
      if ((erro = exigir(atual, 'assumido_manual'))) return recusado(erro);
      if (!evento.pty_fechado) return recusado('Devolver só com o PTY fechado (03 §10)');
      return ir(atual, 'verificando', 'humano');
    case 'pausar':
      return ir(atual, 'pausado_usuario', 'humano');
    case 'retomar':
      if (atual.estado === 'pausado_usuario') return voltar(atual, 'humano');
      if (atual.estado === 'pausado_cota') {
        return evento.creditos_extras_autorizados
          ? voltar(atual, 'humano')
          : recusado('"retomar agora" só com créditos extras autorizados (06 §4.2)');
      }
      return recusado(`retomar não vale em "${atual.estado}"`);
    case 'tentar_novamente':
      if (atual.estado === 'falhou' || atual.estado === 'interrompido') {
        return voltar(atual, 'humano');
      }
      if (atual.estado === 'mergeado_pendente_chamado') return ir(atual, 'comunicando', 'humano');
      // Pedido do usuário (2026-10-03): em `precisa_humano` "tentar de novo" tem
      // que funcionar sempre — volta ao começo da etapa que parou: sem commit,
      // replaneja; com commit, mais um ciclo de implementação.
      if (atual.estado === 'precisa_humano') {
        // FJ-036: conflito com o destino → o agente resolve (nunca "Assumir" por padrão).
        if (atual.motivo_estado === 'conflito_merge') {
          return ir(atual, 'resolvendo_conflito', 'humano');
        }
        // Volta ao começo da ETAPA que parou (relatório estourado não refaz a
        // implementação); sem etapa conhecida, decide pelo commit.
        const porEtapa: Partial<Record<TipoEtapa, EstadoExecucao>> = {
          planejar: 'planejando',
          implementar: 'implementando',
          verificar: 'verificando',
          evidenciar: 'verificando',
          revisar: 'revisando',
          relatar: 'relatando',
          integrar: 'na_fila_merge',
          resolver_conflito: 'resolvendo_conflito',
        };
        const alvo = evento.etapa_anterior ? porEtapa[evento.etapa_anterior] : undefined;
        if (alvo) return ir(atual, alvo, 'humano');
        return evento.existe_commit === false
          ? ir(atual, 'planejando', 'humano')
          : ir(atual, 'implementando', 'humano');
      }
      return recusado(`tentar de novo não vale em "${atual.estado}"`);
    case 'mais_um_ciclo':
      if ((erro = exigir(atual, 'precisa_humano'))) return recusado(erro);
      if (evento.exige_confirmacao && !evento.confirmado) {
        return recusado('acima do teto de ciclos: "mais um ciclo" exige confirmação (03 §6)');
      }
      return ir(atual, 'implementando', 'humano');
    case 'seguir_com_achados':
      if ((erro = exigir(atual, 'precisa_humano'))) return recusado(erro);
      return ir(atual, 'relatando', 'humano');
    case 'editar_relatorio':
      if ((erro = exigir(atual, 'precisa_humano'))) return recusado(erro);
      if (atual.motivo_estado !== 'relatorio_incoerente') {
        return recusado('editar o relatório só com motivo relatorio_incoerente');
      }
      return ir(atual, 'aguardando_aprovacao', 'humano');
    case 'tentar_merge_de_novo':
      if ((erro = exigir(atual, 'precisa_humano'))) return recusado(erro);
      if (atual.motivo_estado !== 'push_recusado') {
        return recusado('voltar à fila de merge só com motivo push_recusado');
      }
      if (!evento.aprovacao_vigente) return recusado('sem aprovação vigente: precisa de G2');
      return ir(atual, 'na_fila_merge', 'humano');
    case 'encerrar':
      return ir(
        atual,
        'cancelado',
        'humano',
        atual.motivo_estado === 'chamado_mudou_no_servidor'
          ? 'chamado_mudou_no_servidor'
          : 'humano_encerrou',
      );
    case 'descartar':
      return ir(atual, 'descartado', 'humano');
    case 'publicado_producao':
      if ((erro = exigir(atual, 'aguardando_deploy'))) return recusado(erro);
      return ir(atual, 'comunicando', 'humano');
  }
  return recusado('evento desconhecido');
}

function irDecisao(atual: EstadoAtualExecucao, d: DecisaoDestino): DecisaoMaquina {
  return ir(atual, d.para, 'codigo', d.motivo ?? null, d.texto ?? null);
}
