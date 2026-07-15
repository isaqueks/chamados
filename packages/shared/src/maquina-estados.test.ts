import { describe, it, expect } from 'vitest';
import {
  transicaoValida,
  podeTransicionar,
  ehTerminal,
  transicoesDoPapel,
  TRANSICOES,
  ATOR_SISTEMA,
  type PapelTransicao,
} from './maquina-estados';
import { StatusChamado, Papel } from './enums';

const TODOS_STATUS = Object.values(StatusChamado);
const ATORES: PapelTransicao[] = [
  Papel.admin,
  Papel.operador,
  Papel.cliente,
  Papel.agente_ia,
  ATOR_SISTEMA,
];

describe('máquina de estados do chamado (specs/04 §1)', () => {
  describe('estados terminais', () => {
    it('fechado e cancelado são terminais', () => {
      expect(ehTerminal(StatusChamado.fechado)).toBe(true);
      expect(ehTerminal(StatusChamado.cancelado)).toBe(true);
      expect(ehTerminal(StatusChamado.novo)).toBe(false);
      expect(ehTerminal(StatusChamado.resolvido)).toBe(false);
    });

    it('nenhuma transição parte de fechado/cancelado, para qualquer papel', () => {
      for (const terminal of [StatusChamado.fechado, StatusChamado.cancelado]) {
        for (const ator of ATORES) {
          for (const para of TODOS_STATUS) {
            const r = transicaoValida(ator, terminal, para);
            expect(r.ok).toBe(false);
          }
        }
      }
    });
  });

  describe('guardrail humano-no-circuito (§1.3): agente_ia NUNCA resolve', () => {
    it('agente_ia não marca em_atendimento → resolvido', () => {
      const r = transicaoValida(
        Papel.agente_ia,
        StatusChamado.em_atendimento,
        StatusChamado.resolvido,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toBe('papel_nao_autorizado');
    });

    it('nenhum caminho leva agente_ia a resolvido', () => {
      for (const de of TODOS_STATUS) {
        expect(podeTransicionar(Papel.agente_ia, de, StatusChamado.resolvido)).toBe(false);
      }
    });

    it('operador e admin marcam resolvido a partir de em_atendimento', () => {
      expect(
        podeTransicionar(Papel.operador, StatusChamado.em_atendimento, StatusChamado.resolvido),
      ).toBe(true);
      expect(
        podeTransicionar(Papel.admin, StatusChamado.em_atendimento, StatusChamado.resolvido),
      ).toBe(true);
    });
  });

  describe('reabertura de resolvido', () => {
    it('resolvido → em_atendimento é permitido a cliente e operador', () => {
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(true);
      expect(
        podeTransicionar(Papel.operador, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(true);
      expect(
        podeTransicionar(Papel.admin, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(true);
    });

    it('agente_ia não reabre', () => {
      expect(
        podeTransicionar(Papel.agente_ia, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(false);
    });
  });

  describe('fechamento de resolvido', () => {
    it('resolvido → fechado é permitido a sistema (auto) e operador (manual)', () => {
      expect(podeTransicionar(ATOR_SISTEMA, StatusChamado.resolvido, StatusChamado.fechado)).toBe(
        true,
      );
      expect(podeTransicionar(Papel.operador, StatusChamado.resolvido, StatusChamado.fechado)).toBe(
        true,
      );
    });

    it('cliente e agente_ia não fecham', () => {
      expect(podeTransicionar(Papel.cliente, StatusChamado.resolvido, StatusChamado.fechado)).toBe(
        false,
      );
      expect(
        podeTransicionar(Papel.agente_ia, StatusChamado.resolvido, StatusChamado.fechado),
      ).toBe(false);
    });
  });

  describe('cancelamento e suas regras (§1.3)', () => {
    it('cliente cancela novo e aguardando_cliente', () => {
      expect(podeTransicionar(Papel.cliente, StatusChamado.novo, StatusChamado.cancelado)).toBe(
        true,
      );
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.aguardando_cliente, StatusChamado.cancelado),
      ).toBe(true);
    });

    it('cliente NÃO cancela em_triagem nem em_atendimento', () => {
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.em_triagem, StatusChamado.cancelado),
      ).toBe(false);
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.em_atendimento, StatusChamado.cancelado),
      ).toBe(false);
    });

    it('operador cancela de novo/em_triagem/aguardando_cliente/em_atendimento', () => {
      for (const de of [
        StatusChamado.novo,
        StatusChamado.em_triagem,
        StatusChamado.aguardando_cliente,
        StatusChamado.em_atendimento,
      ]) {
        expect(podeTransicionar(Papel.operador, de, StatusChamado.cancelado)).toBe(true);
      }
    });

    it('agente_ia nunca cancela', () => {
      for (const de of TODOS_STATUS) {
        expect(podeTransicionar(Papel.agente_ia, de, StatusChamado.cancelado)).toBe(false);
      }
    });
  });

  describe('transições de sistema', () => {
    it('só o sistema inicia triagem (novo → em_triagem) e re-enfileira (aguardando_cliente → em_triagem)', () => {
      expect(podeTransicionar(ATOR_SISTEMA, StatusChamado.novo, StatusChamado.em_triagem)).toBe(
        true,
      );
      expect(
        podeTransicionar(ATOR_SISTEMA, StatusChamado.aguardando_cliente, StatusChamado.em_triagem),
      ).toBe(true);
      for (const ator of [Papel.operador, Papel.cliente, Papel.agente_ia]) {
        expect(podeTransicionar(ator, StatusChamado.novo, StatusChamado.em_triagem)).toBe(false);
      }
    });
  });

  describe('triagem: agente_ia e operador', () => {
    it('em_triagem → aguardando_cliente / em_atendimento por agente_ia e operador', () => {
      for (const para of [StatusChamado.aguardando_cliente, StatusChamado.em_atendimento]) {
        expect(podeTransicionar(Papel.agente_ia, StatusChamado.em_triagem, para)).toBe(true);
        expect(podeTransicionar(Papel.operador, StatusChamado.em_triagem, para)).toBe(true);
      }
    });

    it('cliente não faz transições de triagem', () => {
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.em_triagem, StatusChamado.em_atendimento),
      ).toBe(false);
      expect(
        podeTransicionar(Papel.cliente, StatusChamado.em_atendimento, StatusChamado.resolvido),
      ).toBe(false);
    });
  });

  describe('motivos de negação', () => {
    it('mesmo status → mesmo_status', () => {
      const r = transicaoValida(Papel.operador, StatusChamado.novo, StatusChamado.novo);
      expect(r).toEqual({ ok: false, motivo: 'mesmo_status' });
    });

    it('aresta inexistente → transicao_inexistente', () => {
      const r = transicaoValida(Papel.operador, StatusChamado.novo, StatusChamado.resolvido);
      expect(r).toEqual({ ok: false, motivo: 'transicao_inexistente' });
    });

    it('aresta existente mas papel errado → papel_nao_autorizado', () => {
      const r = transicaoValida(
        Papel.cliente,
        StatusChamado.em_triagem,
        StatusChamado.em_atendimento,
      );
      expect(r).toEqual({ ok: false, motivo: 'papel_nao_autorizado' });
    });

    it('a partir de terminal → estado_terminal', () => {
      const r = transicaoValida(
        Papel.operador,
        StatusChamado.fechado,
        StatusChamado.em_atendimento,
      );
      expect(r).toEqual({ ok: false, motivo: 'estado_terminal' });
    });
  });

  describe('admin ⊇ operador', () => {
    it('admin pode toda transição que operador pode', () => {
      for (const t of TRANSICOES) {
        if (t.papeis.includes(Papel.operador)) {
          expect(podeTransicionar(Papel.admin, t.de, t.para)).toBe(true);
        }
      }
    });
  });

  describe('transicoesDoPapel (para a UI)', () => {
    it('lista os alvos permitidos por papel a partir de um status', () => {
      expect(transicoesDoPapel(Papel.operador, StatusChamado.em_atendimento).sort()).toEqual(
        [StatusChamado.aguardando_cliente, StatusChamado.cancelado, StatusChamado.resolvido].sort(),
      );
      expect(transicoesDoPapel(Papel.cliente, StatusChamado.resolvido)).toEqual([
        StatusChamado.em_atendimento,
      ]);
      expect(transicoesDoPapel(Papel.operador, StatusChamado.fechado)).toEqual([]);
    });
  });
});
