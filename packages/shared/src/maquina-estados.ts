/**
 * Máquina de estados do Chamado (specs/04 §1). Implementação PURA e testável:
 * não toca banco, não depende de infra. A camada de serviço (packages/db) aplica
 * esta máquina + `autorizar()` + RLS antes de persistir qualquer transição.
 *
 * A tabela de transições (§1.3) codifica QUEM (papel) pode disparar cada
 * transição status→status. Invariantes cobertas:
 *  - `fechado`/`cancelado` são terminais: nenhuma transição parte deles.
 *  - Guardrail humano-no-circuito: `agente_ia` NUNCA marca `resolvido`
 *    (em_atendimento → resolvido é só de operador/admin).
 *  - Reabertura: `resolvido` → `em_atendimento` (cliente autor ou operador).
 *  - `admin ⊇ operador`: toda transição de operador vale também para admin.
 *  - Cancelamento e suas regras: cliente (autor) cancela `novo`/`aguardando_cliente`;
 *    operador cancela também `em_triagem`/`em_atendimento`.
 *
 * O ownership do cliente (só age nos PRÓPRIOS chamados) é responsabilidade da
 * camada de serviço via `autorizar()`; aqui decidimos apenas papel × transição.
 */
import { StatusChamado, Papel } from './enums';

/**
 * Ator de uma transição. Além dos papéis de usuário, o `sistema` dispara
 * transições automáticas (job de triagem: `novo`→`em_triagem`; re-enfileiramento:
 * `aguardando_cliente`→`em_triagem`; auto-fechamento: `resolvido`→`fechado`).
 */
export const ATOR_SISTEMA = 'sistema' as const;
export type PapelTransicao = Papel | typeof ATOR_SISTEMA;

/** Uma aresta da máquina de estados: de → para, com os papéis autorizados. */
export interface Transicao {
  de: StatusChamado;
  para: StatusChamado;
  papeis: readonly PapelTransicao[];
}

const { novo, em_triagem, aguardando_cliente, em_atendimento, resolvido, fechado, cancelado } =
  StatusChamado;
const { operador, cliente, agente_ia } = Papel;

/**
 * Tabela canônica de transições (specs/04 §1.3). Fonte única da verdade para
 * quem pode transicionar o quê. `admin` é resolvido por herança de `operador`.
 */
export const TRANSICOES: readonly Transicao[] = [
  { de: novo, para: em_triagem, papeis: [ATOR_SISTEMA] },
  { de: novo, para: cancelado, papeis: [cliente, operador] },
  { de: em_triagem, para: aguardando_cliente, papeis: [agente_ia, operador] },
  { de: em_triagem, para: em_atendimento, papeis: [agente_ia, operador] },
  { de: em_triagem, para: cancelado, papeis: [operador] },
  { de: aguardando_cliente, para: em_triagem, papeis: [ATOR_SISTEMA] },
  { de: aguardando_cliente, para: em_atendimento, papeis: [operador] },
  { de: aguardando_cliente, para: cancelado, papeis: [cliente, operador] },
  { de: em_atendimento, para: aguardando_cliente, papeis: [operador, agente_ia] },
  { de: em_atendimento, para: resolvido, papeis: [operador] },
  { de: em_atendimento, para: cancelado, papeis: [operador] },
  { de: resolvido, para: em_atendimento, papeis: [cliente, operador] },
  { de: resolvido, para: fechado, papeis: [ATOR_SISTEMA, operador] },
];

/** Estados terminais (§1.1): não aceitam transições, mensagens nem atribuições. */
const TERMINAIS: readonly StatusChamado[] = [fechado, cancelado];

/** Um status é terminal? */
export function ehTerminal(status: StatusChamado): boolean {
  return TERMINAIS.includes(status);
}

/** Um papel pode disparar uma transição cujos papéis autorizados são `papeis`? */
function papelAutorizado(papel: PapelTransicao, papeis: readonly PapelTransicao[]): boolean {
  if (papeis.includes(papel)) return true;
  // admin ⊇ operador: onde operador pode, admin também pode.
  if (papel === Papel.admin && papeis.includes(operador)) return true;
  return false;
}

/** Motivo pelo qual uma transição foi negada. */
export type MotivoNegacao =
  'mesmo_status' | 'estado_terminal' | 'transicao_inexistente' | 'papel_nao_autorizado';

/** Resultado de `transicaoValida`: ok ou negada com motivo. */
export type ResultadoTransicao = { ok: true } | { ok: false; motivo: MotivoNegacao };

/**
 * Decide se `ator` (papel) pode transicionar de `de` para `para`, retornando o
 * MOTIVO da negação quando aplicável. Não avalia ownership nem tenant — isso é
 * responsabilidade da camada de serviço (`autorizar()` + RLS).
 */
export function transicaoValida(
  ator: PapelTransicao,
  de: StatusChamado,
  para: StatusChamado,
): ResultadoTransicao {
  if (de === para) return { ok: false, motivo: 'mesmo_status' };
  if (ehTerminal(de)) return { ok: false, motivo: 'estado_terminal' };
  const t = TRANSICOES.find((x) => x.de === de && x.para === para);
  if (!t) return { ok: false, motivo: 'transicao_inexistente' };
  if (!papelAutorizado(ator, t.papeis)) return { ok: false, motivo: 'papel_nao_autorizado' };
  return { ok: true };
}

/** Açúcar booleano sobre `transicaoValida`. */
export function podeTransicionar(
  ator: PapelTransicao,
  de: StatusChamado,
  para: StatusChamado,
): boolean {
  return transicaoValida(ator, de, para).ok;
}

/**
 * Alvos de transição que `ator` pode alcançar a partir de `de` (útil para a UI
 * mostrar só as ações permitidas). Vazio para estados terminais.
 */
export function transicoesDoPapel(ator: PapelTransicao, de: StatusChamado): StatusChamado[] {
  if (ehTerminal(de)) return [];
  return TRANSICOES.filter((t) => t.de === de && papelAutorizado(ator, t.papeis)).map(
    (t) => t.para,
  );
}
