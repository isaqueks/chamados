import { Papel, StatusUsuario } from "@chamados/shared"

/** Rótulos amigáveis (pt-BR) dos papéis, para exibição na UI. */
export const ROTULO_PAPEL: Record<Papel, string> = {
  [Papel.admin]: "Administrador",
  [Papel.operador]: "Operador",
  [Papel.cliente]: "Cliente",
  [Papel.agente_ia]: "Assistente (IA)",
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
