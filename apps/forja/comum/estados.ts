/**
 * Enums canônicos da Forja (fonte da verdade: specs/forja/00 §7 — glossário — e
 * specs/forja/02 §2). Mesmo padrão de `packages/shared/src/enums.ts`: `const`
 * object (chave = valor, snake_case pt-BR) + tipo derivado com o mesmo nome.
 *
 * POR QUE uma constante por enum: o mesmo objeto alimenta o zod (`z.enum(Obj)`),
 * as entidades TypeORM, o `CHECK (col IN (...))` das migrations (via `valores()`)
 * e os rótulos da UI. Valor novo = migration (o SQLite não altera CHECK).
 *
 * Os enums do Chamados (`status`, `natureza`, `prioridade`, `complexidade`,
 * `visibilidade`) NÃO são redefinidos aqui: vêm de `@chamados/shared` (F-18).
 *
 * Este módulo é `comum/`: importado por server/ e web/, sem Node nem DOM.
 */

/** Valores de um enum-objeto como tupla não vazia (para `CHECK IN (...)` e afins). */
export function valores<T extends Record<string, string>>(obj: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(obj) as [T[keyof T], ...T[keyof T][]];
}

// ---------------------------------------------------------------------------
// Execução (02 §2.1, 00 §7.4)
// ---------------------------------------------------------------------------

/** Estado da `execucao` (1 chamado × 1 tentativa). Transições em specs/forja/03 §2.4. */
export const EstadoExecucao = {
  na_fila: 'na_fila',
  preparando: 'preparando',
  planejando: 'planejando',
  plano_pronto: 'plano_pronto',
  aguardando_plano: 'aguardando_plano',
  aguardando_decisao: 'aguardando_decisao',
  aguardando_cliente_resposta: 'aguardando_cliente_resposta',
  implementando: 'implementando',
  verificando: 'verificando',
  revisando: 'revisando',
  relatando: 'relatando',
  aguardando_aprovacao: 'aguardando_aprovacao',
  retrabalho_humano: 'retrabalho_humano',
  na_fila_merge: 'na_fila_merge',
  integrando: 'integrando',
  resolvendo_conflito: 'resolvendo_conflito',
  mergeado: 'mergeado',
  comunicando: 'comunicando',
  mergeado_pendente_chamado: 'mergeado_pendente_chamado',
  aguardando_deploy: 'aguardando_deploy',
  concluido: 'concluido',
  precisa_humano: 'precisa_humano',
  descartado: 'descartado',
  cancelado: 'cancelado',
  pausado_usuario: 'pausado_usuario',
  pausado_cota: 'pausado_cota',
  assumido_manual: 'assumido_manual',
  interrompido: 'interrompido',
  falhou: 'falhou',
} as const;
export type EstadoExecucao = (typeof EstadoExecucao)[keyof typeof EstadoExecucao];

/** Classe do estado (coluna "classe" de 02 §2.1). */
export const ClasseEstadoExecucao = {
  ativo: 'ativo',
  gate: 'gate',
  espera: 'espera',
  terminal: 'terminal',
  lateral: 'lateral',
} as const;
export type ClasseEstadoExecucao = (typeof ClasseEstadoExecucao)[keyof typeof ClasseEstadoExecucao];

export const CLASSE_ESTADO_EXECUCAO: Record<EstadoExecucao, ClasseEstadoExecucao> = {
  na_fila: 'ativo',
  preparando: 'ativo',
  planejando: 'ativo',
  plano_pronto: 'ativo',
  aguardando_plano: 'gate',
  aguardando_decisao: 'gate',
  aguardando_cliente_resposta: 'espera',
  implementando: 'ativo',
  verificando: 'ativo',
  revisando: 'ativo',
  relatando: 'ativo',
  aguardando_aprovacao: 'gate',
  retrabalho_humano: 'ativo',
  na_fila_merge: 'ativo',
  integrando: 'ativo',
  resolvendo_conflito: 'ativo',
  mergeado: 'ativo',
  comunicando: 'ativo',
  mergeado_pendente_chamado: 'espera',
  aguardando_deploy: 'gate',
  concluido: 'terminal',
  precisa_humano: 'espera',
  descartado: 'terminal',
  cancelado: 'terminal',
  pausado_usuario: 'lateral',
  pausado_cota: 'lateral',
  assumido_manual: 'lateral',
  interrompido: 'lateral',
  falhou: 'lateral',
};

/** "Execução ativa" = qualquer estado não terminal (02 §2.1; índice I-1). */
export function estadoAtivo(estado: EstadoExecucao): boolean {
  return CLASSE_ESTADO_EXECUCAO[estado] !== 'terminal';
}

/** Laterais sempre gravam `estado_anterior` (invariante I-9). */
export function estadoLateral(estado: EstadoExecucao): boolean {
  return CLASSE_ESTADO_EXECUCAO[estado] === 'lateral';
}

/**
 * Grupo visual do estado (specs/forja/06 §3.2): define tom, ícone do
 * `EstadoExecucaoBadge` e quem entra no contador "aguardando você". Fica em
 * `comum/` porque o servidor também conta "aguardando você" para o cabeçalho.
 */
export const GrupoEstadoExecucao = {
  esperando_recurso: 'esperando_recurso',
  trabalhando: 'trabalhando',
  aguardando_voce: 'aguardando_voce',
  precisa_atencao: 'precisa_atencao',
  aguardando_terceiros: 'aguardando_terceiros',
  pausado: 'pausado',
  com_voce: 'com_voce',
  concluido: 'concluido',
  encerrado: 'encerrado',
} as const;
export type GrupoEstadoExecucao = (typeof GrupoEstadoExecucao)[keyof typeof GrupoEstadoExecucao];

export const GRUPO_ESTADO_EXECUCAO: Record<EstadoExecucao, GrupoEstadoExecucao> = {
  na_fila: 'esperando_recurso',
  plano_pronto: 'esperando_recurso',
  na_fila_merge: 'esperando_recurso',
  preparando: 'trabalhando',
  planejando: 'trabalhando',
  implementando: 'trabalhando',
  verificando: 'trabalhando',
  revisando: 'trabalhando',
  relatando: 'trabalhando',
  retrabalho_humano: 'trabalhando',
  integrando: 'trabalhando',
  resolvendo_conflito: 'trabalhando',
  comunicando: 'trabalhando',
  aguardando_plano: 'aguardando_voce',
  aguardando_decisao: 'aguardando_voce',
  aguardando_aprovacao: 'aguardando_voce',
  precisa_humano: 'precisa_atencao',
  falhou: 'precisa_atencao',
  interrompido: 'precisa_atencao',
  mergeado_pendente_chamado: 'precisa_atencao',
  aguardando_cliente_resposta: 'aguardando_terceiros',
  aguardando_deploy: 'aguardando_terceiros',
  pausado_usuario: 'pausado',
  pausado_cota: 'pausado',
  assumido_manual: 'com_voce',
  mergeado: 'concluido',
  concluido: 'concluido',
  descartado: 'encerrado',
  cancelado: 'encerrado',
};

/**
 * Conta em "Aguardando você (N)"? (06 §1.2): grupos "aguardando você" e
 * "precisa de atenção", mais `aguardando_cliente_resposta` com resposta já
 * detectada. `aguardando_deploy` nunca entra (pode durar dias).
 */
export function contaEmAguardandoVoce(
  estado: EstadoExecucao,
  clienteRespondeu: boolean = false,
): boolean {
  const grupo = GRUPO_ESTADO_EXECUCAO[estado];
  if (grupo === 'aguardando_voce' || grupo === 'precisa_atencao') return true;
  return estado === 'aguardando_cliente_resposta' && clienteRespondeu;
}

/** Motivo de `precisa_humano`/`falhou`/`cancelado` — lista FECHADA (02 §2.2; ações em 03 §2.4/§11). */
export const MotivoEstado = {
  ciclos_esgotados: 'ciclos_esgotados',
  pingue_pongue: 'pingue_pongue',
  /** Obsoleto (FJ-032): o app não roda mais comandos do projeto. Só linhas antigas. */
  verificacao_ambiente: 'verificacao_ambiente',
  /** Obsoleto (FJ-032): não há mais linha de base. Só linhas antigas (migradas na 0003). */
  base_vermelha: 'base_vermelha',
  setup_falhou: 'setup_falhou',
  conflito_merge: 'conflito_merge',
  conflito_schema: 'conflito_schema',
  schema_concorrente: 'schema_concorrente',
  push_recusado: 'push_recusado',
  relatorio_incoerente: 'relatorio_incoerente',
  saida_invalida: 'saida_invalida',
  regra_conteudo_violada: 'regra_conteudo_violada',
  timeout_etapa: 'timeout_etapa',
  orcamento_etapa: 'orcamento_etapa',
  segunda_interrupcao: 'segunda_interrupcao',
  sentinela_divergente: 'sentinela_divergente',
  perfil_divergente: 'perfil_divergente',
  nao_implementavel: 'nao_implementavel',
  chamado_mudou_no_servidor: 'chamado_mudou_no_servidor',
  ia_servidor_ativa: 'ia_servidor_ativa',
  transicao_recusada: 'transicao_recusada',
  cota_overage: 'cota_overage',
  humano_encerrou: 'humano_encerrou',
} as const;
export type MotivoEstado = (typeof MotivoEstado)[keyof typeof MotivoEstado];

// ---------------------------------------------------------------------------
// Etapa (02 §2.2, 00 §7.3, 01 §6.6)
// ---------------------------------------------------------------------------

/**
 * Tipo da `etapa`. `verificar`, `evidenciar` e `integrar` são do app (sem `session_id`).
 * `verificar` é a COLETA desde FJ-032 (sha verificado, selos, evidências e os
 * comandos que o T1 rodou, lidos do stream) — nenhum processo.
 */
export const TipoEtapa = {
  planejar: 'planejar',
  implementar: 'implementar',
  verificar: 'verificar',
  evidenciar: 'evidenciar',
  revisar: 'revisar',
  relatar: 'relatar',
  conversar: 'conversar',
  integrar: 'integrar',
  resolver_conflito: 'resolver_conflito',
} as const;
export type TipoEtapa = (typeof TipoEtapa)[keyof typeof TipoEtapa];

/** Etapas executadas pelo próprio app (sem processo `claude`). */
export const ETAPAS_DO_APP: readonly TipoEtapa[] = ['verificar', 'evidenciar', 'integrar'];

export const EstadoEtapa = {
  executando: 'executando',
  concluida: 'concluida',
  falhou: 'falhou',
  interrompida: 'interrompida',
  cancelada: 'cancelada',
} as const;
export type EstadoEtapa = (typeof EstadoEtapa)[keyof typeof EstadoEtapa];

/**
 * Classificação única que o runner devolve ao fim de um processo `claude`
 * (01 §6.6). O mapeamento para estados de `execucao` fica em 03.
 */
export const ClassificacaoProcesso = {
  concluido: 'concluido',
  saida_invalida: 'saida_invalida',
  limite_orcamento: 'limite_orcamento',
  limite_turnos: 'limite_turnos',
  cota: 'cota',
  autenticacao: 'autenticacao',
  perfil_divergente: 'perfil_divergente',
  pausado: 'pausado',
  cancelado: 'cancelado',
  timeout: 'timeout',
  interrompido: 'interrompido',
  erro_execucao: 'erro_execucao',
} as const;
export type ClassificacaoProcesso =
  (typeof ClassificacaoProcesso)[keyof typeof ClassificacaoProcesso];

/**
 * `etapa.motivo_fim`: a classificação do runner + os motivos das etapas do app (02 §2.2).
 * `comando_vermelho`/`comando_ambiente` vêm de antes de FJ-032 (verificação pelo
 * app) e ainda fecham etapas `integrar` que falham (conflito, push, remoto).
 */
export const MotivoFimEtapa = {
  ...ClassificacaoProcesso,
  comando_vermelho: 'comando_vermelho',
  comando_ambiente: 'comando_ambiente',
} as const;
export type MotivoFimEtapa = (typeof MotivoFimEtapa)[keyof typeof MotivoFimEtapa];

/** Papel de agente (00 §7.2). O `relator` é o turno T3 do condutor. */
export const PapelAgente = {
  planejador: 'planejador',
  condutor: 'condutor',
  implementador: 'implementador',
  revisor_correcao: 'revisor_correcao',
  revisor_seguranca: 'revisor_seguranca',
  testador_e2e: 'testador_e2e',
  relator: 'relator',
  resolvedor_conflito: 'resolvedor_conflito',
} as const;
export type PapelAgente = (typeof PapelAgente)[keyof typeof PapelAgente];

/** Turno da sessão condutora (00 §7.8). */
export const TurnoCondutor = { T1: 'T1', T2: 'T2', T3: 'T3' } as const;
export type TurnoCondutor = (typeof TurnoCondutor)[keyof typeof TurnoCondutor];

// ---------------------------------------------------------------------------
// Artefatos, verificação e evidência visual (02 §2.2, 00 §7.6, FJ-026)
// ---------------------------------------------------------------------------

export const TipoArtefato = {
  plano: 'plano',
  resumo_impl: 'resumo_impl',
  veredito: 'veredito',
  relatorio: 'relatorio',
  resposta: 'resposta',
  diff: 'diff',
  log: 'log',
  evidencia: 'evidencia',
  prompt: 'prompt',
} as const;
export type TipoArtefato = (typeof TipoArtefato)[keyof typeof TipoArtefato];

/**
 * Nível de verificação ⚙ (calculado pelo app, nunca arredondado para cima).
 *
 * Desde FJ-032 a Forja não executa comandos do projeto: quem roda os checks é
 * o agente, e o app cruza o que o revisor RELATOU (`veredito.v1.comandos_executados`)
 * com os `tool_result` de Bash do stream do T2. `verificado_pelo_revisor` = todo
 * comando relatado foi visto no stream com exit 0; `declarado` = relatado mas não
 * confirmado (ausente, divergente ou vermelho); `nao_verificado` = nada relatado.
 *
 * Obsoletos (só linhas anteriores a FJ-032; nunca escritos): `e2e_automatizado`,
 * `e2e_roteiro`, `verificacao_estatica` — eram calculados dos comandos que o app rodava.
 */
export const NivelVerificacao = {
  verificado_pelo_revisor: 'verificado_pelo_revisor',
  declarado: 'declarado',
  nao_verificado: 'nao_verificado',
  e2e_automatizado: 'e2e_automatizado',
  e2e_roteiro: 'e2e_roteiro',
  verificacao_estatica: 'verificacao_estatica',
} as const;
export type NivelVerificacao = (typeof NivelVerificacao)[keyof typeof NivelVerificacao];

/** Níveis que o app ainda escreve (FJ-032). Os demais só existem em linhas antigas. */
export const NIVEIS_VERIFICACAO_ATUAIS = [
  'verificado_pelo_revisor',
  'declarado',
  'nao_verificado',
] as const satisfies readonly NivelVerificacao[];

/** Nível ⚙ dos prints antes/depois de uma execução (FJ-026). Não altera o nível de verificação. */
export const EvidenciaVisual = {
  completa: 'completa',
  parcial: 'parcial',
  sem_evidencia_visual: 'sem_evidencia_visual',
  nao_se_aplica: 'nao_se_aplica',
} as const;
export type EvidenciaVisual = (typeof EvidenciaVisual)[keyof typeof EvidenciaVisual];

export const MomentoEvidencia = { antes: 'antes', depois: 'depois' } as const;
export type MomentoEvidencia = (typeof MomentoEvidencia)[keyof typeof MomentoEvidencia];

/** Resultado da captura de uma tela na etapa `evidenciar` (02 §4.7 `etapa.telas`). */
export const ResultadoTela = {
  ok: 'ok',
  reaproveitado: 'reaproveitado',
  tela_nova: 'tela_nova',
  nao_encontrada: 'nao_encontrada',
  timeout: 'timeout',
  login_falhou: 'login_falhou',
  app_nao_subiu: 'app_nao_subiu',
} as const;
export type ResultadoTela = (typeof ResultadoTela)[keyof typeof ResultadoTela];

// ---------------------------------------------------------------------------
// Gates e aprovações (00 §7.5, 02 §2.2)
// ---------------------------------------------------------------------------

export const Gate = {
  G0: 'G0',
  G1: 'G1',
  Gdec: 'Gdec',
  G2: 'G2',
  G2_linha: "G2'",
  Gdeploy: 'Gdeploy',
} as const;
export type Gate = (typeof Gate)[keyof typeof Gate];

/** `aprovacao.tipo` (G1, Gdec, G2, G2', Gdeploy). */
export const TipoAprovacao = {
  plano: 'plano',
  decisao: 'decisao',
  final: 'final',
  reaprovacao: 'reaprovacao',
  publicado_producao: 'publicado_producao',
} as const;
export type TipoAprovacao = (typeof TipoAprovacao)[keyof typeof TipoAprovacao];

export const DecisaoAprovacao = {
  aprovado: 'aprovado',
  aprovado_com_edicao: 'aprovado_com_edicao',
  ajustes_pedidos: 'ajustes_pedidos',
  descartado: 'descartado',
} as const;
export type DecisaoAprovacao = (typeof DecisaoAprovacao)[keyof typeof DecisaoAprovacao];

export const AlvoComentario = {
  plano: 'plano',
  diff: 'diff',
  relatorio: 'relatorio',
  resposta: 'resposta',
} as const;
export type AlvoComentario = (typeof AlvoComentario)[keyof typeof AlvoComentario];

// ---------------------------------------------------------------------------
// Outbox para o Chamados (02 §2.2, 03 §9)
// ---------------------------------------------------------------------------

/** `silenciar_ia`/`reativar_ia`: só compatibilidade de banco — nunca enfileirados (FJ-031). */
export const PassoOutbox = {
  silenciar_ia: 'silenciar_ia',
  atribuir: 'atribuir',
  nota_inicio: 'nota_inicio',
  pergunta_publica: 'pergunta_publica',
  status_aguardando_cliente: 'status_aguardando_cliente',
  status_em_atendimento: 'status_em_atendimento',
  nota_interna: 'nota_interna',
  mensagem_publica: 'mensagem_publica',
  status_resolvido: 'status_resolvido',
  status_fechado: 'status_fechado',
  desatribuir: 'desatribuir',
  reativar_ia: 'reativar_ia',
  nota_descarte: 'nota_descarte',
} as const;
export type PassoOutbox = (typeof PassoOutbox)[keyof typeof PassoOutbox];

export const EstadoOutbox = {
  pendente: 'pendente',
  retido: 'retido',
  enviando: 'enviando',
  enviado: 'enviado',
  pulado: 'pulado',
  bloqueado: 'bloqueado',
} as const;
export type EstadoOutbox = (typeof EstadoOutbox)[keyof typeof EstadoOutbox];

// ---------------------------------------------------------------------------
// Fila de merge e entrega (02 §2.2, 03 §8)
// ---------------------------------------------------------------------------

export const EstadoItemFilaMerge = {
  aguardando: 'aguardando',
  integrando: 'integrando',
  verificando: 'verificando',
  publicando: 'publicando',
  concluido: 'concluido',
  devolvido: 'devolvido',
  conflito: 'conflito',
} as const;
export type EstadoItemFilaMerge = (typeof EstadoItemFilaMerge)[keyof typeof EstadoItemFilaMerge];

export const ModoAvancoRef = {
  update_ref: 'update_ref',
  push_direto: 'push_direto',
  ff_copia_limpa: 'ff_copia_limpa',
} as const;
export type ModoAvancoRef = (typeof ModoAvancoRef)[keyof typeof ModoAvancoRef];

/** Modo de entrega — default `merge_e_push` (U-2); `pull_request` = Fase 2. */
export const ModoEntrega = {
  merge_local: 'merge_local',
  merge_e_push: 'merge_e_push',
  pull_request: 'pull_request',
} as const;
export type ModoEntrega = (typeof ModoEntrega)[keyof typeof ModoEntrega];

export const EstrategiaIntegracao = {
  merge_no_ff: 'merge_no_ff',
  squash: 'squash',
} as const;
export type EstrategiaIntegracao = (typeof EstrategiaIntegracao)[keyof typeof EstrategiaIntegracao];

/** Política de conclusão — default `resolvido` (U-1). */
export const PoliticaStatus = {
  resolvido: 'resolvido',
  fechado_imediato: 'fechado_imediato',
  aguardar_deploy: 'aguardar_deploy',
} as const;
export type PoliticaStatus = (typeof PoliticaStatus)[keyof typeof PoliticaStatus];

// ---------------------------------------------------------------------------
// Projeto, lote, terminal, conexão, eventos (02 §2.2)
// ---------------------------------------------------------------------------

/** Gate de plano por projeto (o lote força `sempre`). */
export const GatePlano = {
  sempre: 'sempre',
  por_risco: 'por_risco',
  nunca: 'nunca',
} as const;
export type GatePlano = (typeof GatePlano)[keyof typeof GatePlano];

export const EstadoLote = {
  planejando: 'planejando',
  mesa_de_planos: 'mesa_de_planos',
  implementando: 'implementando',
  encerrado: 'encerrado',
  cancelado: 'cancelado',
} as const;
export type EstadoLote = (typeof EstadoLote)[keyof typeof EstadoLote];

export const TipoSessaoTerminal = {
  livre: 'livre',
  assumida: 'assumida',
} as const;
export type TipoSessaoTerminal = (typeof TipoSessaoTerminal)[keyof typeof TipoSessaoTerminal];

export const OrigemEvento = {
  app: 'app',
  cli: 'cli',
  comando: 'comando',
  chamados: 'chamados',
  humano: 'humano',
} as const;
export type OrigemEvento = (typeof OrigemEvento)[keyof typeof OrigemEvento];

/** Onde está a senha do operador dedicado (02 §8). */
export const LocalSenha = {
  keyring: 'keyring',
  arquivo: 'arquivo',
  nao_guardada: 'nao_guardada',
} as const;
export type LocalSenha = (typeof LocalSenha)[keyof typeof LocalSenha];

/** `conexao_chamados.ambiente` (02 §4.1): faixa visual e confirmação extra em produção. */
export const AmbienteConexao = {
  dev: 'dev',
  producao: 'producao',
} as const;
export type AmbienteConexao = (typeof AmbienteConexao)[keyof typeof AmbienteConexao];

/** Status do `rate_limit_event` gravado em `uso_assinatura` (02 §4.14). */
export const StatusCota = {
  allowed: 'allowed',
  allowed_warning: 'allowed_warning',
  rejected: 'rejected',
} as const;
export type StatusCota = (typeof StatusCota)[keyof typeof StatusCota];

/** Modo de execução do servidor local (01 §12). */
export const ModoForja = {
  dev: 'dev',
  producao: 'producao',
} as const;
export type ModoForja = (typeof ModoForja)[keyof typeof ModoForja];
