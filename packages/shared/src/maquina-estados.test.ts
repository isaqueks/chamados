import { describe, it, expect } from 'vitest';
import {
  transicaoValida,
  podeTransicionar,
  ehTerminal,
  ehReabertura,
  podeReabrir,
  ehAprovacaoDoCliente,
  ehContestacao,
  transicoesDoPapel,
  situacaoDoStatus,
  STATUS_ABERTOS,
  STATUS_ENCERRADOS,
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

    it('de fechado/cancelado a ÚNICA saída é a reabertura → em_atendimento (D-038)', () => {
      for (const terminal of [StatusChamado.fechado, StatusChamado.cancelado]) {
        for (const ator of ATORES) {
          for (const para of TODOS_STATUS) {
            const r = transicaoValida(ator, terminal, para);
            if (para !== StatusChamado.em_atendimento) {
              expect(r.ok).toBe(false);
              if (para !== terminal) expect(r).toEqual({ ok: false, motivo: 'estado_terminal' });
            }
          }
        }
      }
      const saidas = TRANSICOES.filter(
        (t) => t.de === StatusChamado.fechado || t.de === StatusChamado.cancelado,
      );
      expect(saidas.map((t) => t.para)).toEqual([
        StatusChamado.em_atendimento,
        StatusChamado.em_atendimento,
      ]);
    });
  });

  describe('guardrail humano-no-circuito (§1.3, D-017): agente_ia só resolve na triagem', () => {
    it('agente_ia não marca em_atendimento → resolvido', () => {
      const r = transicaoValida(
        Papel.agente_ia,
        StatusChamado.em_atendimento,
        StatusChamado.resolvido,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toBe('papel_nao_autorizado');
    });

    it('agente_ia marca resolvido SOMENTE a partir de em_triagem (dúvida — D-017)', () => {
      for (const de of TODOS_STATUS) {
        expect(podeTransicionar(Papel.agente_ia, de, StatusChamado.resolvido)).toBe(
          de === StatusChamado.em_triagem,
        );
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

  describe('reabertura (specs/04 §8.2, D-038)', () => {
    const REABRIVEIS: readonly StatusChamado[] = [
      StatusChamado.resolvido,
      StatusChamado.fechado,
      StatusChamado.cancelado,
    ];

    it('resolvido/fechado/cancelado → em_atendimento: cliente, operador e admin', () => {
      for (const de of REABRIVEIS) {
        for (const ator of [Papel.cliente, Papel.operador, Papel.admin]) {
          expect(podeTransicionar(ator, de, StatusChamado.em_atendimento)).toBe(true);
          expect(podeReabrir(ator, de)).toBe(true);
        }
      }
    });

    it('agente_ia e sistema nunca reabrem (encerrado responde estado_terminal)', () => {
      for (const de of REABRIVEIS) {
        for (const ator of [Papel.agente_ia, ATOR_SISTEMA]) {
          expect(podeTransicionar(ator, de, StatusChamado.em_atendimento)).toBe(false);
          expect(podeReabrir(ator, de)).toBe(false);
        }
      }
      for (const de of [StatusChamado.fechado, StatusChamado.cancelado]) {
        expect(transicaoValida(Papel.agente_ia, de, StatusChamado.em_atendimento)).toEqual({
          ok: false,
          motivo: 'estado_terminal',
        });
        expect(transicaoValida(ATOR_SISTEMA, de, StatusChamado.em_atendimento)).toEqual({
          ok: false,
          motivo: 'estado_terminal',
        });
      }
      expect(
        transicaoValida(Papel.agente_ia, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toEqual({ ok: false, motivo: 'papel_nao_autorizado' });
    });

    it('podeReabrir é falso fora dos status reabríveis', () => {
      for (const de of TODOS_STATUS.filter((s) => !REABRIVEIS.includes(s))) {
        for (const ator of ATORES) expect(podeReabrir(ator, de)).toBe(false);
      }
    });

    it('ehReabertura: só X → em_atendimento com X reabrível', () => {
      for (const de of TODOS_STATUS) {
        for (const para of TODOS_STATUS) {
          expect(ehReabertura(de, para)).toBe(
            para === StatusChamado.em_atendimento && REABRIVEIS.includes(de),
          );
        }
      }
    });

    it('fechado/cancelado continuam terminais (encerrados salvo reabertura)', () => {
      expect(ehTerminal(StatusChamado.fechado)).toBe(true);
      expect(ehTerminal(StatusChamado.cancelado)).toBe(true);
    });
  });

  describe('fechamento de resolvido', () => {
    it('resolvido → fechado é permitido a sistema (tácita), cliente (aprovação — D-042) e operador (manual)', () => {
      for (const ator of [ATOR_SISTEMA, Papel.cliente, Papel.operador, Papel.admin] as const) {
        expect(podeTransicionar(ator, StatusChamado.resolvido, StatusChamado.fechado)).toBe(true);
      }
    });

    it('agente_ia nunca fecha nem aprova (D-042)', () => {
      expect(
        transicaoValida(Papel.agente_ia, StatusChamado.resolvido, StatusChamado.fechado),
      ).toEqual({ ok: false, motivo: 'papel_nao_autorizado' });
    });

    it('cliente só fecha a partir de resolvido (aprovar não pula etapas)', () => {
      for (const de of TODOS_STATUS) {
        if (de === StatusChamado.resolvido) continue;
        expect(podeTransicionar(Papel.cliente, de, StatusChamado.fechado)).toBe(false);
      }
    });
  });

  describe('janela de aprovação (D-042)', () => {
    it('ehAprovacaoDoCliente: só cliente em resolvido → fechado', () => {
      expect(
        ehAprovacaoDoCliente(Papel.cliente, StatusChamado.resolvido, StatusChamado.fechado),
      ).toBe(true);
      for (const ator of [ATOR_SISTEMA, Papel.operador, Papel.admin, Papel.agente_ia] as const) {
        expect(ehAprovacaoDoCliente(ator, StatusChamado.resolvido, StatusChamado.fechado)).toBe(
          false,
        );
      }
      expect(
        ehAprovacaoDoCliente(Papel.cliente, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(false);
    });

    it('ehContestacao: só cliente em resolvido → em_atendimento (reabrir fechado/cancelado não é contestar)', () => {
      expect(
        ehContestacao(Papel.cliente, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(true);
      expect(
        ehContestacao(Papel.operador, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(false);
      expect(
        ehContestacao(Papel.cliente, StatusChamado.fechado, StatusChamado.em_atendimento),
      ).toBe(false);
      expect(
        ehContestacao(Papel.cliente, StatusChamado.cancelado, StatusChamado.em_atendimento),
      ).toBe(false);
    });

    it('agente_ia não contesta nem aprova pela máquina', () => {
      expect(
        podeTransicionar(Papel.agente_ia, StatusChamado.resolvido, StatusChamado.em_atendimento),
      ).toBe(false);
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

    it('a partir de terminal, fora da reabertura → estado_terminal', () => {
      expect(
        transicaoValida(Papel.operador, StatusChamado.fechado, StatusChamado.resolvido),
      ).toEqual({ ok: false, motivo: 'estado_terminal' });
      expect(
        transicaoValida(Papel.operador, StatusChamado.cancelado, StatusChamado.aguardando_cliente),
      ).toEqual({ ok: false, motivo: 'estado_terminal' });
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
      // D-042: em resolvido o cliente contesta (→ em_atendimento) ou aprova (→ fechado).
      expect(transicoesDoPapel(Papel.cliente, StatusChamado.resolvido)).toEqual([
        StatusChamado.em_atendimento,
        StatusChamado.fechado,
      ]);
      // Encerrado: só a reabertura, e só para quem pode reabrir (D-038).
      for (const de of [StatusChamado.fechado, StatusChamado.cancelado]) {
        for (const ator of [Papel.operador, Papel.admin, Papel.cliente]) {
          expect(transicoesDoPapel(ator, de)).toEqual([StatusChamado.em_atendimento]);
        }
        expect(transicoesDoPapel(Papel.agente_ia, de)).toEqual([]);
        expect(transicoesDoPapel(ATOR_SISTEMA, de)).toEqual([]);
      }
    });
  });

  describe('situação agregada (D-030)', () => {
    it('abertos e encerrados PARTICIONAM os sete status canônicos', () => {
      const uniao = [...STATUS_ABERTOS, ...STATUS_ENCERRADOS];
      expect(uniao.slice().sort()).toEqual(TODOS_STATUS.slice().sort());
      expect(new Set(uniao).size).toBe(uniao.length); // sem interseção
    });

    it('situacaoDoStatus classifica todo status em exatamente um grupo', () => {
      for (const s of TODOS_STATUS) {
        const g = situacaoDoStatus(s);
        expect(g === 'abertos' ? STATUS_ABERTOS : STATUS_ENCERRADOS).toContain(s);
      }
    });

    it('todo status TERMINAL é encerrado, mas encerrado ⊅ terminal (resolvido reabre)', () => {
      for (const s of TODOS_STATUS) {
        if (ehTerminal(s)) expect(situacaoDoStatus(s)).toBe('encerrados');
      }
      expect(ehTerminal(StatusChamado.resolvido)).toBe(false);
      expect(situacaoDoStatus(StatusChamado.resolvido)).toBe('encerrados');
    });
  });
});
