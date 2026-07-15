import { Papel, StatusUsuario, StatusChamado, Natureza, Prioridade } from "@chamados/shared"

/** Rótulos amigáveis (pt-BR) dos papéis, para exibição na UI. */
export const ROTULO_PAPEL: Record<Papel, string> = {
  [Papel.admin]: "Administrador",
  [Papel.operador]: "Operador",
  [Papel.cliente]: "Cliente",
  [Papel.agente_ia]: "Assistente (IA)",
}

/** Rótulos amigáveis do status do chamado (specs/04 §1). */
export const ROTULO_STATUS_CHAMADO: Record<StatusChamado, string> = {
  [StatusChamado.novo]: "Novo",
  [StatusChamado.em_triagem]: "Em triagem",
  [StatusChamado.aguardando_cliente]: "Aguardando cliente",
  [StatusChamado.em_atendimento]: "Em atendimento",
  [StatusChamado.resolvido]: "Resolvido",
  [StatusChamado.fechado]: "Fechado",
  [StatusChamado.cancelado]: "Cancelado",
}

/** Variante de Badge por status (visual coerente com o ciclo de vida). */
export const VARIANTE_STATUS: Record<
  StatusChamado,
  "default" | "secondary" | "outline" | "muted"
> = {
  [StatusChamado.novo]: "default",
  [StatusChamado.em_triagem]: "secondary",
  [StatusChamado.aguardando_cliente]: "outline",
  [StatusChamado.em_atendimento]: "default",
  [StatusChamado.resolvido]: "secondary",
  [StatusChamado.fechado]: "muted",
  [StatusChamado.cancelado]: "muted",
}

/** Rótulos amigáveis da natureza. */
export const ROTULO_NATUREZA: Record<Natureza, string> = {
  [Natureza.problema]: "Problema",
  [Natureza.alteracao]: "Alteração",
}

/** Rótulos amigáveis da prioridade. */
export const ROTULO_PRIORIDADE: Record<Prioridade, string> = {
  [Prioridade.baixa]: "Baixa",
  [Prioridade.media]: "Média",
  [Prioridade.alta]: "Alta",
  [Prioridade.urgente]: "Urgente",
}

/** Rótulos amigáveis do status do vínculo usuário↔tenant. */
export const ROTULO_STATUS_USUARIO: Record<StatusUsuario, string> = {
  [StatusUsuario.pendente]: "Pendente",
  [StatusUsuario.ativo]: "Ativo",
  [StatusUsuario.suspenso]: "Suspenso",
  [StatusUsuario.removido]: "Removido",
}

/** Iniciais para o avatar a partir do nome. */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return "?"
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase()
  return (partes[0]![0]! + partes[partes.length - 1]![0]!).toUpperCase()
}
