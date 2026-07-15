/**
 * Enums canônicos da plataforma (fonte da verdade: specs/02-modelo-de-dados.md).
 *
 * Padrão: `const object` (chave = valor, ambos em snake_case pt-BR) + tipo
 * derivado com o mesmo nome. Os valores string são EXATAMENTE os do brief
 * canônico e devem casar 1:1 com os tipos ENUM nativos criados no PostgreSQL.
 */

// ---------------------------------------------------------------------------
// Chamado
// ---------------------------------------------------------------------------

/** Ciclo de vida do chamado (transições em specs/04-chamados.md). */
export const StatusChamado = {
  novo: 'novo',
  em_triagem: 'em_triagem',
  aguardando_cliente: 'aguardando_cliente',
  em_atendimento: 'em_atendimento',
  resolvido: 'resolvido',
  fechado: 'fechado',
  cancelado: 'cancelado',
} as const;
export type StatusChamado = (typeof StatusChamado)[keyof typeof StatusChamado];

/** Natureza do chamado. */
export const Natureza = {
  problema: 'problema',
  alteracao: 'alteracao',
} as const;
export type Natureza = (typeof Natureza)[keyof typeof Natureza];

/** Prioridade do chamado. */
export const Prioridade = {
  baixa: 'baixa',
  media: 'media',
  alta: 'alta',
  urgente: 'urgente',
} as const;
export type Prioridade = (typeof Prioridade)[keyof typeof Prioridade];

/** Complexidade (avaliação interna: operador/admin/agente_ia). */
export const Complexidade = {
  facil: 'facil',
  medio: 'medio',
  dificil: 'dificil',
} as const;
export type Complexidade = (typeof Complexidade)[keyof typeof Complexidade];

/** Visibilidade de uma mensagem na timeline. */
export const VisibilidadeMensagem = {
  publica: 'publica',
  interna: 'interna',
} as const;
export type VisibilidadeMensagem =
  (typeof VisibilidadeMensagem)[keyof typeof VisibilidadeMensagem];

/**
 * Tipos de evento de auditoria (`EventoChamado`). Taxonomia canônica ÚNICA —
 * fonte da verdade: specs/02 §"tipo_evento". As transições notáveis do ciclo de
 * vida têm evento próprio (`chamado_reaberto`, `chamado_resolvido`,
 * `chamado_fechado`, `chamado_fechado_auto`, `chamado_cancelado`) e NÃO emitem
 * também `status_alterado` (sem duplicidade). Atribuição usa o par
 * `operador_atribuido`/`operador_desatribuido`. Os tipos `ia_*` são gravados a
 * partir de M6+ (pipeline do agente_ia), mas o enum já os inclui.
 */
export const TipoEvento = {
  chamado_criado: 'chamado_criado',
  status_alterado: 'status_alterado',
  prioridade_alterada: 'prioridade_alterada',
  natureza_alterada: 'natureza_alterada',
  complexidade_alterada: 'complexidade_alterada',
  operador_atribuido: 'operador_atribuido',
  operador_desatribuido: 'operador_desatribuido',
  mensagem_publicada: 'mensagem_publicada',
  nota_interna_publicada: 'nota_interna_publicada',
  anexo_adicionado: 'anexo_adicionado',
  chamado_reaberto: 'chamado_reaberto',
  chamado_resolvido: 'chamado_resolvido',
  chamado_fechado: 'chamado_fechado',
  chamado_fechado_auto: 'chamado_fechado_auto',
  chamado_cancelado: 'chamado_cancelado',
  ia_iniciou: 'ia_iniciou',
  ia_pediu_info: 'ia_pediu_info',
  ia_diagnosticou: 'ia_diagnosticou',
  ia_abriu_pr: 'ia_abriu_pr',
  ia_gerou_spec: 'ia_gerou_spec',
  ia_falhou: 'ia_falhou',
} as const;
export type TipoEvento = (typeof TipoEvento)[keyof typeof TipoEvento];

// ---------------------------------------------------------------------------
// Usuário / Tenant
// ---------------------------------------------------------------------------

/** Papel (role) do usuário. */
export const Papel = {
  admin: 'admin',
  operador: 'operador',
  cliente: 'cliente',
  agente_ia: 'agente_ia',
} as const;
export type Papel = (typeof Papel)[keyof typeof Papel];

/** Status de acesso do tenant (governa login). */
export const StatusTenant = {
  em_provisionamento: 'em_provisionamento',
  ativo: 'ativo',
  suspenso: 'suspenso',
  cancelado: 'cancelado',
} as const;
export type StatusTenant = (typeof StatusTenant)[keyof typeof StatusTenant];

/** Status do vínculo usuário↔tenant. */
export const StatusUsuario = {
  pendente: 'pendente',
  ativo: 'ativo',
  suspenso: 'suspenso',
  removido: 'removido',
} as const;
export type StatusUsuario = (typeof StatusUsuario)[keyof typeof StatusUsuario];

/** Ciclo de vida de um convite de acesso (ver specs/03 §4.2). */
export const StatusConvite = {
  pendente: 'pendente',
  aceito: 'aceito',
  expirado: 'expirado',
  revogado: 'revogado',
} as const;
export type StatusConvite = (typeof StatusConvite)[keyof typeof StatusConvite];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lista os valores de um enum-objeto (útil para criar o ENUM no Postgres). */
export function valoresEnum<T extends Record<string, string>>(e: T): Array<T[keyof T]> {
  return Object.values(e) as Array<T[keyof T]>;
}
