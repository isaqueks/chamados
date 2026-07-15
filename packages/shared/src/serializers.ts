/**
 * Serializers do papel `cliente` — allowlist de campos (specs/03 §7).
 *
 * Regra de ouro: qualquer recurso exposto ao `cliente` EXCLUI por padrão notas
 * internas, `complexidade` e `ExecucaoIA`. Usamos allowlist (só o que pode sair),
 * nunca denylist. Estas funções são a fronteira de dados na serialização; a
 * fronteira de escrita/leitura no banco é `autorizar()` + RLS.
 *
 * As interfaces de entrada refletem o esquema canônico de specs/02. As entidades
 * Chamado/Mensagem completas chegam em marcos posteriores (M3+); aqui já deixamos
 * o serializer pronto e testado para quando os dados existirem.
 */
import { VisibilidadeMensagem } from './enums';
import type { StatusChamado, Natureza, Prioridade, Complexidade } from './enums';

/** Forma "completa" (interna) de uma mensagem, como vive no banco (specs/02). */
export interface MensagemInterna {
  id: string;
  chamado_id: string;
  autor_id: string;
  visibilidade: VisibilidadeMensagem;
  corpo_json: unknown;
  corpo_html: string;
  execucao_ia_id?: string | null;
  created_at: Date | string;
}

/** Projeção que o cliente pode ver de uma mensagem pública. */
export interface MensagemCliente {
  id: string;
  autor_id: string;
  corpo_json: unknown;
  corpo_html: string;
  created_at: Date | string;
}

/** Forma "completa" (interna) de um chamado, como vive no banco (specs/02). */
export interface ChamadoInterno {
  id: string;
  numero: number | string;
  tenant_id: string;
  sistema_alvo_id?: string | null;
  categoria_id?: string | null;
  cliente_id: string;
  operador_id?: string | null;
  titulo: string;
  descricao_json: unknown;
  descricao_html: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade?: Complexidade | null;
  resolvido_em?: Date | string | null;
  fechar_automaticamente_em?: Date | string | null;
  fechado_em?: Date | string | null;
  reaberto_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Projeção que o cliente pode ver de um chamado próprio. */
export interface ChamadoCliente {
  id: string;
  numero: number | string;
  sistema_alvo_id?: string | null;
  categoria_id?: string | null;
  cliente_id: string;
  titulo: string;
  descricao_json: unknown;
  descricao_html: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  resolvido_em?: Date | string | null;
  fechado_em?: Date | string | null;
  reaberto_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Serializa uma mensagem para o cliente. Retorna `null` se a mensagem for
 * `interna` (o cliente nunca deve nem saber que ela existe). Nunca vaza
 * `visibilidade` nem `execucao_ia_id`.
 */
export function serializarMensagemParaCliente(
  m: MensagemInterna,
): MensagemCliente | null {
  if (m.visibilidade !== VisibilidadeMensagem.publica) return null;
  return {
    id: m.id,
    autor_id: m.autor_id,
    corpo_json: m.corpo_json,
    corpo_html: m.corpo_html,
    created_at: m.created_at,
  };
}

/** Serializa uma timeline para o cliente, descartando notas internas. */
export function serializarTimelineParaCliente(
  mensagens: MensagemInterna[],
): MensagemCliente[] {
  return mensagens
    .map(serializarMensagemParaCliente)
    .filter((m): m is MensagemCliente => m !== null);
}

/**
 * Serializa um chamado para o cliente. Exclui `complexidade` (campo interno) e
 * `operador_id` (atribuição de operador não é exposta ao cliente — specs/03 §7).
 */
export function serializarChamadoParaCliente(c: ChamadoInterno): ChamadoCliente {
  return {
    id: c.id,
    numero: c.numero,
    sistema_alvo_id: c.sistema_alvo_id ?? null,
    categoria_id: c.categoria_id ?? null,
    cliente_id: c.cliente_id,
    titulo: c.titulo,
    descricao_json: c.descricao_json,
    descricao_html: c.descricao_html,
    status: c.status,
    natureza: c.natureza,
    prioridade: c.prioridade,
    resolvido_em: c.resolvido_em ?? null,
    fechado_em: c.fechado_em ?? null,
    reaberto_count: c.reaberto_count,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}
