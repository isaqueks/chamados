import { describe, expect, it } from 'vitest';
import { StatusChamado, transicaoValida } from '@chamados/shared';
import { calcularCadeia, type AlvoCadeia } from './cadeia-status';

/**
 * Cadeia de status (specs/forja/07 §5, §13): TODAS as origens × alvos,
 * calculada sobre a máquina de `@chamados/shared` — e cada aresta devolvida é
 * conferida de novo com `transicaoValida('operador', …)`.
 */

type Esperado = 'ja_esta' | StatusChamado[] | `impossivel:${string}`;

const ESPERADO: Record<StatusChamado, Record<AlvoCadeia, Esperado>> = {
  novo: {
    em_atendimento: 'impossivel:sem_caminho',
    aguardando_cliente: 'impossivel:sem_caminho',
    resolvido: 'impossivel:sem_caminho',
    fechado: 'impossivel:sem_caminho',
  },
  em_triagem: {
    em_atendimento: ['em_atendimento'],
    aguardando_cliente: ['aguardando_cliente'],
    // Nunca pela aresta direta em_triagem → resolvido (D-017 é da IA).
    resolvido: ['em_atendimento', 'resolvido'],
    fechado: ['em_atendimento', 'resolvido', 'fechado'],
  },
  aguardando_cliente: {
    em_atendimento: ['em_atendimento'],
    aguardando_cliente: 'ja_esta',
    resolvido: ['em_atendimento', 'resolvido'],
    fechado: ['em_atendimento', 'resolvido', 'fechado'],
  },
  em_atendimento: {
    em_atendimento: 'ja_esta',
    aguardando_cliente: ['aguardando_cliente'],
    resolvido: ['resolvido'],
    fechado: ['resolvido', 'fechado'],
  },
  resolvido: {
    em_atendimento: 'impossivel:exige_reabrir',
    aguardando_cliente: 'impossivel:exige_reabrir',
    resolvido: 'ja_esta',
    fechado: ['fechado'],
  },
  fechado: {
    em_atendimento: 'impossivel:estado_terminal',
    aguardando_cliente: 'impossivel:estado_terminal',
    resolvido: 'impossivel:estado_terminal',
    fechado: 'ja_esta',
  },
  cancelado: {
    em_atendimento: 'impossivel:estado_terminal',
    aguardando_cliente: 'impossivel:estado_terminal',
    resolvido: 'impossivel:estado_terminal',
    fechado: 'impossivel:estado_terminal',
  },
};

const ALVOS: AlvoCadeia[] = ['em_atendimento', 'aguardando_cliente', 'resolvido', 'fechado'];

describe('calcularCadeia — todas as origens × alvos', () => {
  for (const de of Object.values(StatusChamado)) {
    for (const alvo of ALVOS) {
      it(`${de} → ${alvo}`, () => {
        const c = calcularCadeia(de, alvo);
        const esperado = ESPERADO[de][alvo];
        if (esperado === 'ja_esta') expect(c.tipo).toBe('ja_esta');
        else if (typeof esperado === 'string') {
          expect(c).toMatchObject({ tipo: 'impossivel', motivo: esperado.split(':')[1] });
        } else {
          expect(c).toEqual({ tipo: 'cadeia', de, passos: esperado });
          let atual: StatusChamado = de;
          for (const p of esperado) {
            expect(transicaoValida('operador', atual, p).ok).toBe(true);
            atual = p;
          }
        }
      });
    }
  }
});

describe('opções', () => {
  it('admin herda as arestas do operador', () => {
    expect(calcularCadeia('aguardando_cliente', 'resolvido', { papel: 'admin' })).toMatchObject({
      passos: ['em_atendimento', 'resolvido'],
    });
  });

  it('reabrir só com permitirReabrir', () => {
    expect(calcularCadeia('resolvido', 'em_atendimento', { permitirReabrir: true })).toMatchObject({
      tipo: 'cadeia',
      passos: ['em_atendimento'],
    });
  });
});
