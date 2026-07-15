"use server"

import { revalidatePath } from "next/cache"
import {
  obterAppDataSource,
  runInTenantContext,
  criarChamado,
  transicionarStatus,
  type MotivoCriar,
} from "@chamados/db"
import { Natureza, Prioridade, StatusChamado } from "@chamados/shared"
import { exigirUsuario } from "@/lib/sessao"

export interface EstadoChamado {
  erro?: string
  sucesso?: string
}

const MOTIVOS_CRIAR: Record<MotivoCriar, string> = {
  sem_permissao: "Sem permissão para abrir chamados.",
  solicitante_obrigatorio: "Informe o solicitante do chamado.",
  solicitante_invalido: "Solicitante inválido.",
  titulo_invalido: "O título deve ter entre 3 e 160 caracteres.",
  descricao_obrigatoria: "Descreva o chamado.",
  descricao_muito_longa: "A descrição excede o limite de 50.000 caracteres.",
  natureza_invalida: "Selecione a natureza do chamado.",
  prioridade_invalida: "Prioridade inválida.",
  sistema_alvo_obrigatorio: "Selecione o sistema-alvo.",
  sistema_alvo_invalido: "Sistema-alvo inválido.",
  categoria_invalida: "Categoria inválida.",
}

function ehNatureza(v: string): v is Natureza {
  return (Object.values(Natureza) as string[]).includes(v)
}
function ehPrioridade(v: string): v is Prioridade {
  return (Object.values(Prioridade) as string[]).includes(v)
}
function ehStatus(v: string): v is StatusChamado {
  return (Object.values(StatusChamado) as string[]).includes(v)
}

/** Abre um chamado com o formulário mínimo (specs/04 §2). */
export async function acaoCriarChamado(
  _prev: EstadoChamado,
  formData: FormData,
): Promise<EstadoChamado> {
  const { tenant, usuario } = await exigirUsuario()

  const titulo = String(formData.get("titulo") ?? "").trim()
  const descricao = String(formData.get("descricao") ?? "")
  const naturezaRaw = String(formData.get("natureza") ?? "")
  const prioridadeRaw = String(formData.get("prioridade") ?? "")

  if (!ehNatureza(naturezaRaw)) return { erro: "Selecione a natureza do chamado." }
  const prioridade =
    prioridadeRaw === "" ? undefined : ehPrioridade(prioridadeRaw) ? prioridadeRaw : null
  if (prioridade === null) return { erro: "Prioridade inválida." }

  const ds = await obterAppDataSource()
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    criarChamado(em, usuario, {
      titulo,
      descricao,
      natureza: naturezaRaw,
      prioridade,
    }),
  )
  if (!r.ok) return { erro: MOTIVOS_CRIAR[r.motivo] }

  revalidatePath("/app/chamados")
  return { sucesso: `Chamado #${r.numero} aberto.` }
}

/** Aplica uma transição de status (máquina de estados — specs/04 §1). */
export async function acaoTransicionar(formData: FormData): Promise<void> {
  const { tenant, usuario } = await exigirUsuario()
  const id = String(formData.get("id") ?? "")
  const novoStatus = String(formData.get("novo_status") ?? "")
  if (!id || !ehStatus(novoStatus)) return

  const ds = await obterAppDataSource()
  await runInTenantContext(ds, tenant.id, (em) =>
    transicionarStatus(em, usuario, id, novoStatus),
  )
  revalidatePath("/app/chamados")
}
