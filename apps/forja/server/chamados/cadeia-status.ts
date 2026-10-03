import {
  ehTerminal,
  transicaoValida,
  transicoesDoPapel,
  type Papel,
  type StatusChamado,
} from '@chamados/shared';

/**
 * Cadeia de transições do chamado que a Forja precisa fazer a partir do status
 * LIDO (specs/forja/07 §5; 03 §9.1).
 *
 * POR QUE calcular e não tabelar: a máquina de estados é do Chamados
 * (`TRANSICOES` em `packages/shared/src/maquina-estados.ts`); a Forja importa
 * `transicoesDoPapel`/`transicaoValida` (F-18) e faz uma busca em largura sobre
 * elas. Assim uma mudança na máquina muda a cadeia sem tocar aqui, e o outbox
 * nunca presume o status — ele relê o detalhe e recalcula antes de cada passo.
 *
 * Políticas da Forja POR CIMA da máquina (07 §5, §11.6):
 *  - nunca passa por `cancelado`;
 *  - nunca usa a aresta direta `em_triagem → resolvido` (a auditoria fica
 *    legível passando por `em_atendimento`; no servidor ela é a da D-017);
 *  - não REABRE (`resolvido → em_atendimento`) por padrão: se o chamado aparece
 *    `resolvido` durante a execução, foi um humano (§8) — quem decide é ele;
 *  - `novo` não tem caminho do operador até nenhum alvo (`novo → em_triagem` é
 *    do `sistema`): a cadeia é `impossivel`, e a Forja nem começa (§5).
 */

export type AlvoCadeia = Extract<
  StatusChamado,
  'em_atendimento' | 'aguardando_cliente' | 'resolvido' | 'fechado'
>;

export type MotivoCadeiaImpossivel =
  | 'estado_terminal'
  | 'sem_caminho'
  /** O alvo exigiria reabrir um `resolvido` (só com `permitirReabrir`). */
  | 'exige_reabrir';

export type Cadeia =
  | { tipo: 'ja_esta'; status: StatusChamado }
  | { tipo: 'cadeia'; de: StatusChamado; passos: StatusChamado[] }
  | { tipo: 'impossivel'; de: StatusChamado; motivo: MotivoCadeiaImpossivel };

export interface OpcoesCadeia {
  /** Papel da identidade da Forja (`operador`; `admin` herda). */
  papel?: Extract<Papel, 'operador' | 'admin'>;
  /** Permite `resolvido → em_atendimento` (padrão: não). */
  permitirReabrir?: boolean;
}

/** Arestas que a Forja nunca usa, mesmo válidas na máquina. */
function arestaProibida(de: StatusChamado, para: StatusChamado, opcoes: OpcoesCadeia): boolean {
  if (para === 'cancelado') return true;
  if (de === 'em_triagem' && para === 'resolvido') return true;
  if (de === 'resolvido' && para === 'em_atendimento' && !opcoes.permitirReabrir) return true;
  return false;
}

/**
 * Menor sequência de status (sem o de partida) que leva `lido` até `alvo`, só
 * por arestas que o papel pode disparar — cada uma conferida com
 * `transicaoValida`. Determinística: a ordem de vizinhos é a de `TRANSICOES`.
 */
export function calcularCadeia(
  lido: StatusChamado,
  alvo: AlvoCadeia,
  opcoes: OpcoesCadeia = {},
): Cadeia {
  const papel = opcoes.papel ?? 'operador';
  if (lido === alvo) return { tipo: 'ja_esta', status: lido };
  if (ehTerminal(lido)) return { tipo: 'impossivel', de: lido, motivo: 'estado_terminal' };

  const anterior = new Map<StatusChamado, StatusChamado>();
  const visitados = new Set<StatusChamado>([lido]);
  const fila: StatusChamado[] = [lido];
  while (fila.length > 0) {
    const atual = fila.shift()!;
    for (const prox of transicoesDoPapel(papel, atual)) {
      if (visitados.has(prox) || arestaProibida(atual, prox, opcoes)) continue;
      if (!transicaoValida(papel, atual, prox).ok) continue;
      visitados.add(prox);
      anterior.set(prox, atual);
      if (prox === alvo) {
        const passos: StatusChamado[] = [prox];
        let p = atual;
        while (p !== lido) {
          passos.unshift(p);
          p = anterior.get(p)!;
        }
        return { tipo: 'cadeia', de: lido, passos };
      }
      fila.push(prox);
    }
  }
  if (lido === 'resolvido' && !opcoes.permitirReabrir) {
    const comReabertura = calcularCadeia(lido, alvo, { ...opcoes, permitirReabrir: true });
    if (comReabertura.tipo === 'cadeia') {
      return { tipo: 'impossivel', de: lido, motivo: 'exige_reabrir' };
    }
  }
  return { tipo: 'impossivel', de: lido, motivo: 'sem_caminho' };
}
