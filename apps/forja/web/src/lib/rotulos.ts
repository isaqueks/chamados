import { StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import type {
  EstadoExecucao,
  EvidenciaVisual,
  MotivoEstado,
  NivelVerificacao,
  TipoEtapa,
} from '@comum/estados';

/**
 * Rótulos pt-BR. A primeira parte é CÓPIA LITERAL de apps/web/src/lib/rotulos.ts
 * (specs/forja/06 §3.1: mesmos rótulos do Chamados); a segunda é da Forja
 * (06 §3.2). O identificador cru aparece só em tooltip e na aba Técnico.
 */

// --- Copiados do Chamados --------------------------------------------------

/** Rótulos amigáveis do status do chamado (specs/04 §1). */
export const ROTULO_STATUS_CHAMADO: Record<StatusChamado, string> = {
  [StatusChamado.novo]: 'Novo',
  [StatusChamado.em_triagem]: 'Em triagem',
  [StatusChamado.aguardando_cliente]: 'Aguardando cliente',
  [StatusChamado.em_atendimento]: 'Em atendimento',
  [StatusChamado.resolvido]: 'Resolvido',
  [StatusChamado.fechado]: 'Fechado',
  [StatusChamado.cancelado]: 'Cancelado',
};

/** Rótulos amigáveis da natureza. */
export const ROTULO_NATUREZA: Record<Natureza, string> = {
  [Natureza.problema]: 'Problema',
  [Natureza.alteracao]: 'Alteração',
  [Natureza.duvida]: 'Dúvida',
};

/** Rótulos amigáveis da prioridade. */
export const ROTULO_PRIORIDADE: Record<Prioridade, string> = {
  [Prioridade.baixa]: 'Baixa',
  [Prioridade.media]: 'Média',
  [Prioridade.alta]: 'Alta',
  [Prioridade.urgente]: 'Urgente',
};

/** Rótulos amigáveis da complexidade (interna — nunca exposta ao cliente). */
export const ROTULO_COMPLEXIDADE: Record<Complexidade, string> = {
  [Complexidade.facil]: 'Fácil',
  [Complexidade.medio]: 'Médio',
  [Complexidade.dificil]: 'Difícil',
};

// --- Forja -----------------------------------------------------------------

/** Nome legível de cada estado da execução (06 §3.2). */
export const ROTULO_ESTADO_EXECUCAO: Record<EstadoExecucao, string> = {
  na_fila: 'Na fila',
  preparando: 'Preparando',
  planejando: 'Planejando',
  plano_pronto: 'Plano pronto',
  aguardando_plano: 'Aguardando plano',
  aguardando_decisao: 'Decisão necessária',
  aguardando_cliente_resposta: 'Aguardando cliente',
  implementando: 'Implementando',
  verificando: 'Coletando',
  revisando: 'Revisando',
  relatando: 'Relatando',
  aguardando_aprovacao: 'Aguardando aprovação',
  retrabalho_humano: 'Retrabalho',
  na_fila_merge: 'Na fila de merge',
  integrando: 'Integrando',
  resolvendo_conflito: 'Resolvendo conflito',
  mergeado: 'Mergeado',
  comunicando: 'Comunicando',
  mergeado_pendente_chamado: 'Pendente no Chamados',
  aguardando_deploy: 'Aguardando deploy',
  concluido: 'Concluído',
  precisa_humano: 'Precisa de você',
  descartado: 'Descartado',
  cancelado: 'Cancelado',
  pausado_usuario: 'Pausado',
  pausado_cota: 'Pausado (cota)',
  assumido_manual: 'Assumido no terminal',
  interrompido: 'Interrompido',
  falhou: 'Falhou',
};

export const ROTULO_ETAPA: Record<TipoEtapa, string> = {
  planejar: 'Planejar',
  implementar: 'Implementar',
  verificar: 'Coleta',
  evidenciar: 'Prints',
  revisar: 'Revisar',
  relatar: 'Relatar',
  conversar: 'Conversa',
  integrar: 'Integrar',
  resolver_conflito: 'Resolver conflito',
};

/**
 * Nível de verificação: nunca "testado" sem qualificar (06 §3.2, princípio 3 de
 * §6). Desde FJ-032 quem roda os checks é o agente; a Forja confere o relato
 * contra o stream. Os três últimos só aparecem em execuções anteriores.
 */
export const ROTULO_NIVEL_VERIFICACAO: Record<NivelVerificacao, string> = {
  verificado_pelo_revisor: 'verificado pelo revisor (comandos vistos)',
  declarado: 'declarado pelo revisor (não confirmado)',
  nao_verificado: 'não verificado',
  e2e_automatizado: 'testado ponta a ponta',
  e2e_roteiro: 'testado ponta a ponta por roteiro',
  verificacao_estatica: 'verificação estática (não testado ponta a ponta)',
};

export const ROTULO_EVIDENCIA_VISUAL: Record<EvidenciaVisual, string> = {
  completa: 'prints antes/depois',
  parcial: 'prints parciais',
  sem_evidencia_visual: 'sem prints',
  nao_se_aplica: 'não altera a interface',
};

/** Texto curto de cada motivo de `precisa_humano`/`falhou`/`cancelado`. */
export const ROTULO_MOTIVO_ESTADO: Record<MotivoEstado, string> = {
  ciclos_esgotados: 'limite de ciclos atingido',
  pingue_pongue: 'o mesmo achado voltou',
  // `verificacao_ambiente`/`base_vermelha`: só execuções anteriores a FJ-032.
  verificacao_ambiente: 'falha de ambiente (verificação antiga)',
  base_vermelha: 'linha de base antiga (não existe mais)',
  setup_falhou: 'falha de ambiente (worktree, integração ou reverificação)',
  conflito_merge: 'conflito com o destino',
  conflito_schema: 'conflito de schema',
  schema_concorrente: 'outro chamado de schema em voo',
  push_recusado: 'push recusado',
  relatorio_incoerente: 'relatório contradiz o diff',
  saida_invalida: 'saída do agente inválida',
  regra_conteudo_violada: 'mensagem viola a regra de linguagem',
  timeout_etapa: 'tempo da etapa esgotado',
  orcamento_etapa: 'orçamento da etapa esgotado',
  segunda_interrupcao: 'interrompido duas vezes',
  sentinela_divergente: 'sentinela de integridade divergente',
  perfil_divergente: 'perfil da CLI divergente',
  nao_implementavel: 'não implementável',
  chamado_mudou_no_servidor: 'o chamado mudou no Chamados',
  ia_servidor_ativa: 'a IA do servidor está ativa',
  transicao_recusada: 'o Chamados recusou a transição',
  cota_overage: 'créditos extras não autorizados',
  humano_encerrou: 'encerrado por você',
};
