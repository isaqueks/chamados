/**
 * Máquina de estados do Chamado (specs/04 §1). Implementação PURA e testável:
 * não toca banco, não depende de infra. A camada de serviço (packages/db) aplica
 * esta máquina + `autorizar()` + RLS antes de persistir qualquer transição.
 *
 * A tabela de transições (§1.3) codifica QUEM (papel) pode disparar cada
 * transição status→status. Invariantes cobertas:
 *  - `fechado`/`cancelado` são ENCERRADOS (`ehTerminal`): não aceitam mensagens,
 *    atribuições nem transições — exceto a REABERTURA (D-038), única saída.
 *  - Guardrail humano-no-circuito: `agente_ia` só marca `resolvido` a partir de
 *    `em_triagem` (dúvida respondida sozinha — D-017; o APLICADOR garante que a
 *    aresta só é usada para natureza `duvida` com resposta publicada);
 *    `em_atendimento → resolvido` continua exclusivo de operador/admin.
 *  - Reabertura: `resolvido`/`fechado`/`cancelado` → `em_atendimento` (cliente
 *    autor ou operador/admin — D-038). `agente_ia` e `sistema` nunca reabrem.
 *  - Janela de aprovação (D-042): em `resolvido` o cliente autor APROVA
 *    (`resolvido → fechado`, `ehAprovacaoDoCliente`) ou CONTESTA (`resolvido →
 *    em_atendimento`, `ehContestacao` — exige mensagem, regra do serviço); sem
 *    resposta no prazo, o `sistema` fecha (aprovação tácita). `agente_ia` nunca
 *    aprova nem contesta.
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
 * `aguardando_cliente`→`em_triagem`; aprovação tácita ao fim do prazo — D-042:
 * `resolvido`→`fechado`).
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
  // D-017: dúvida respondida pela IA na triagem → resolvido (o aplicador restringe
  // o uso desta aresta à natureza `duvida` com resposta pública publicada).
  { de: em_triagem, para: resolvido, papeis: [agente_ia, operador] },
  { de: em_triagem, para: cancelado, papeis: [operador] },
  { de: aguardando_cliente, para: em_triagem, papeis: [ATOR_SISTEMA] },
  { de: aguardando_cliente, para: em_atendimento, papeis: [operador] },
  { de: aguardando_cliente, para: cancelado, papeis: [cliente, operador] },
  { de: em_atendimento, para: aguardando_cliente, papeis: [operador, agente_ia] },
  { de: em_atendimento, para: resolvido, papeis: [operador] },
  { de: em_atendimento, para: cancelado, papeis: [operador] },
  // D-042: vindo do cliente, `resolvido → em_atendimento` é a CONTESTAÇÃO da
  // resolução (exige mensagem — regra do serviço) e `resolvido → fechado` é a
  // APROVAÇÃO explícita; o `sistema` fecha ao fim do prazo (aprovação tácita) e
  // o operador continua podendo fechar manualmente.
  { de: resolvido, para: em_atendimento, papeis: [cliente, operador] },
  { de: resolvido, para: fechado, papeis: [ATOR_SISTEMA, cliente, operador] },
  // D-038: reabertura de chamado encerrado — a ÚNICA saída de fechado/cancelado.
  // Nunca agente_ia nem sistema (reabrir é decisão humana).
  { de: fechado, para: em_atendimento, papeis: [cliente, operador] },
  { de: cancelado, para: em_atendimento, papeis: [cliente, operador] },
];

/**
 * Estados terminais (§1.1) — "encerrados salvo reabertura" (D-038): não aceitam
 * mensagens, atribuições, silêncio da IA nem transições, com UMA exceção: a
 * reabertura humana para `em_atendimento` (`podeReabrir`). Quem só precisa saber
 * se o chamado está encerrado (bloquear mensagem, triagem, atribuição) continua
 * usando `ehTerminal`; a máquina abre a exceção em `transicaoValida`.
 */
const TERMINAIS: readonly StatusChamado[] = [fechado, cancelado];

/** Status de onde se pode REABRIR (→ `em_atendimento`): specs/04 §1.3, §8.2, D-038. */
const REABRIVEIS: readonly StatusChamado[] = [resolvido, fechado, cancelado];

/** Um status é terminal (encerrado; só sai por reabertura — D-038)? */
export function ehTerminal(status: StatusChamado): boolean {
  return TERMINAIS.includes(status);
}

/** A transição `de → para` é uma reabertura (evento `chamado_reaberto`, `reaberto_count++`)? */
export function ehReabertura(de: StatusChamado, para: StatusChamado): boolean {
  return para === em_atendimento && REABRIVEIS.includes(de);
}

/**
 * `resolvido → fechado` disparado pelo CLIENTE é a aprovação explícita da
 * resolução (D-042, evento `chamado_aprovado`). Pelo `sistema` é a aprovação
 * tácita (fim do prazo, `chamado_fechado_auto`); pelo operador, fechamento manual.
 */
export function ehAprovacaoDoCliente(
  ator: PapelTransicao,
  de: StatusChamado,
  para: StatusChamado,
): boolean {
  return ator === cliente && de === resolvido && para === fechado;
}

/**
 * `resolvido → em_atendimento` disparado pelo CLIENTE é a CONTESTAÇÃO da
 * resolução (D-042, evento `chamado_contestado` no lugar de `chamado_reaberto`;
 * `reaberto_count` continua contando). O serviço exige uma mensagem pública do
 * cliente na mesma transação (o motivo).
 */
export function ehContestacao(
  ator: PapelTransicao,
  de: StatusChamado,
  para: StatusChamado,
): boolean {
  return ator === cliente && de === resolvido && para === em_atendimento;
}

/**
 * Situação agregada do chamado (D-030): a partição de EXIBIÇÃO usada nos filtros
 * rápidos da fila e nas abas do portal. Não confundir com `ehTerminal`:
 * `resolvido` NÃO é terminal (o cliente ainda pode reabrir), mas para quem olha
 * a fila ele já saiu do trabalho do dia — por isso conta como encerrado.
 */
export type SituacaoChamado = 'abertos' | 'encerrados' | 'todos';

/** Status em que o chamado ainda demanda trabalho da equipe ou do cliente. */
export const STATUS_ABERTOS: readonly StatusChamado[] = [
  novo,
  em_triagem,
  aguardando_cliente,
  em_atendimento,
];

/** Status que saíram da fila de trabalho. Complemento exato de `STATUS_ABERTOS`. */
export const STATUS_ENCERRADOS: readonly StatusChamado[] = [resolvido, fechado, cancelado];

/** A que situação um status pertence (nunca devolve `'todos'`). */
export function situacaoDoStatus(status: StatusChamado): 'abertos' | 'encerrados' {
  return STATUS_ABERTOS.includes(status) ? 'abertos' : 'encerrados';
}

/** Um papel pode disparar uma transição cujos papéis autorizados são `papeis`? */
function papelAutorizado(papel: PapelTransicao, papeis: readonly PapelTransicao[]): boolean {
  if (papeis.includes(papel)) return true;
  // admin ⊇ operador: onde operador pode, admin também pode.
  if (papel === Papel.admin && papeis.includes(operador)) return true;
  return false;
}

/**
 * `ator` pode reabrir um chamado em `status` (→ `em_atendimento`)? Decide só
 * papel × status: o ownership do cliente (só os próprios chamados) é da camada
 * de serviço via `autorizar(..., 'chamado', 'mudar_status')`.
 */
export function podeReabrir(ator: PapelTransicao, status: StatusChamado): boolean {
  return ehReabertura(status, em_atendimento) && podeTransicionar(ator, status, em_atendimento);
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
  const t = TRANSICOES.find((x) => x.de === de && x.para === para);
  // Encerrado (D-038): a única saída é a reabertura por papel autorizado; para
  // todo o resto — inclusive agente_ia/sistema tentando reabrir — o chamado
  // continua "terminal" e o motivo segue `estado_terminal` (contrato da API).
  if (ehTerminal(de) && (!t || !papelAutorizado(ator, t.papeis))) {
    return { ok: false, motivo: 'estado_terminal' };
  }
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
 * mostrar só as ações permitidas). Em estado terminal, só a reabertura
 * (`[em_atendimento]`) para quem pode reabrir; vazio para os demais (D-038).
 */
export function transicoesDoPapel(ator: PapelTransicao, de: StatusChamado): StatusChamado[] {
  return TRANSICOES.filter((t) => t.de === de && papelAutorizado(ator, t.papeis)).map(
    (t) => t.para,
  );
}
