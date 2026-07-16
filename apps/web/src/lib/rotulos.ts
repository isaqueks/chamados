import {
  Papel,
  StatusUsuario,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  TipoEvento,
  StatusExecucaoIA,
  GatilhoIA,
} from '@chamados/shared';

/** Rótulos amigáveis (pt-BR) dos papéis, para exibição na UI. */
export const ROTULO_PAPEL: Record<Papel, string> = {
  [Papel.admin]: 'Administrador',
  [Papel.operador]: 'Operador',
  [Papel.cliente]: 'Cliente',
  [Papel.agente_ia]: 'Assistente (IA)',
};

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

/** Variante de Badge por status (visual coerente com o ciclo de vida). */
export const VARIANTE_STATUS: Record<StatusChamado, 'default' | 'secondary' | 'outline' | 'muted'> =
  {
    [StatusChamado.novo]: 'default',
    [StatusChamado.em_triagem]: 'secondary',
    [StatusChamado.aguardando_cliente]: 'outline',
    [StatusChamado.em_atendimento]: 'default',
    [StatusChamado.resolvido]: 'secondary',
    [StatusChamado.fechado]: 'muted',
    [StatusChamado.cancelado]: 'muted',
  };

/** Rótulos amigáveis da natureza. */
export const ROTULO_NATUREZA: Record<Natureza, string> = {
  [Natureza.problema]: 'Problema',
  [Natureza.alteracao]: 'Alteração',
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

/** Rótulos amigáveis do status do vínculo usuário↔tenant. */
export const ROTULO_STATUS_USUARIO: Record<StatusUsuario, string> = {
  [StatusUsuario.pendente]: 'Pendente',
  [StatusUsuario.ativo]: 'Ativo',
  [StatusUsuario.suspenso]: 'Suspenso',
  [StatusUsuario.removido]: 'Removido',
};

/** Rótulos amigáveis dos eventos de auditoria (timeline — specs/04 §9). */
export const ROTULO_TIPO_EVENTO: Record<TipoEvento, string> = {
  [TipoEvento.chamado_criado]: 'abriu o chamado',
  [TipoEvento.status_alterado]: 'mudou o status',
  [TipoEvento.prioridade_alterada]: 'alterou a prioridade',
  [TipoEvento.natureza_alterada]: 'alterou a natureza',
  [TipoEvento.complexidade_alterada]: 'alterou a complexidade',
  [TipoEvento.operador_atribuido]: 'atribuiu um operador',
  [TipoEvento.operador_desatribuido]: 'removeu a atribuição',
  [TipoEvento.mensagem_publicada]: 'publicou uma mensagem',
  [TipoEvento.nota_interna_publicada]: 'publicou uma nota interna',
  [TipoEvento.anexo_adicionado]: 'adicionou um anexo',
  [TipoEvento.chamado_reaberto]: 'reabriu o chamado',
  [TipoEvento.chamado_resolvido]: 'marcou como resolvido',
  [TipoEvento.chamado_fechado]: 'fechou o chamado',
  [TipoEvento.chamado_fechado_auto]: 'fechou automaticamente',
  [TipoEvento.chamado_cancelado]: 'cancelou o chamado',
  [TipoEvento.ia_iniciou]: 'IA iniciou a triagem',
  [TipoEvento.ia_pediu_info]: 'IA pediu informações',
  [TipoEvento.ia_diagnosticou]: 'IA publicou diagnóstico',
  [TipoEvento.ia_abriu_pr]: 'IA abriu um PR',
  [TipoEvento.ia_gerou_spec]: 'IA gerou uma SPEC',
  [TipoEvento.ia_falhou]: 'execução da IA falhou',
};

/** Rótulos do status de uma ExecucaoIA (painel Assistente IA — specs/08 §4.3). */
export const ROTULO_STATUS_EXECUCAO_IA: Record<StatusExecucaoIA, string> = {
  [StatusExecucaoIA.na_fila]: 'Na fila',
  [StatusExecucaoIA.executando]: 'Executando',
  [StatusExecucaoIA.concluido]: 'Concluída',
  [StatusExecucaoIA.falhou]: 'Falhou',
  [StatusExecucaoIA.cancelado]: 'Cancelada',
};

/** Variante de Badge por status da execução (visual coerente). */
export const VARIANTE_EXECUCAO_IA: Record<
  StatusExecucaoIA,
  'default' | 'secondary' | 'outline' | 'muted' | 'destructive'
> = {
  [StatusExecucaoIA.na_fila]: 'outline',
  [StatusExecucaoIA.executando]: 'secondary',
  [StatusExecucaoIA.concluido]: 'default',
  [StatusExecucaoIA.falhou]: 'destructive',
  [StatusExecucaoIA.cancelado]: 'muted',
};

/** Rótulos do gatilho de uma triagem (specs/05 §2). */
export const ROTULO_GATILHO_IA: Record<string, string> = {
  [GatilhoIA.chamado_criado]: 'Abertura do chamado',
  [GatilhoIA.resposta_cliente]: 'Resposta do cliente',
  [GatilhoIA.reprocessamento_manual]: 'Reprocessamento manual',
  [GatilhoIA.mapeamento]: 'Mapeamento do sistema',
};

/** Iniciais para o avatar a partir do nome. */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return (partes[0]![0]! + partes[partes.length - 1]![0]!).toUpperCase();
}
