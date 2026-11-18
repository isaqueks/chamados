import { describe, it, expect } from 'vitest';
import {
  DIAS_APROVACAO_PADRAO,
  DIAS_APROVACAO_MIN,
  DIAS_APROVACAO_MAX,
  normalizarDiasAprovacao,
  diasAprovacaoValido,
  calcularPrazoAprovacao,
  situacaoAprovacao,
  formatarPrazoAprovacao,
} from './aprovacao';
import { StatusChamado } from './enums';

describe('janela de aprovação do cliente (D-042)', () => {
  it('o prazo padrão é 7 dias, com faixa 1–365', () => {
    expect(DIAS_APROVACAO_PADRAO).toBe(7);
    expect(DIAS_APROVACAO_MIN).toBe(1);
    expect(DIAS_APROVACAO_MAX).toBe(365);
  });

  it('calcularPrazoAprovacao soma os dias à resolução', () => {
    const base = new Date('2026-11-17T12:00:00.000Z');
    expect(calcularPrazoAprovacao(base, 7).toISOString()).toBe('2026-11-24T12:00:00.000Z');
    expect(calcularPrazoAprovacao(base, 1).toISOString()).toBe('2026-11-18T12:00:00.000Z');
  });

  it('valor fora da faixa ou inválido não abre janela absurda', () => {
    const base = new Date('2026-11-17T12:00:00.000Z');
    expect(calcularPrazoAprovacao(base, 0).toISOString()).toBe('2026-11-18T12:00:00.000Z');
    expect(calcularPrazoAprovacao(base, 3650).getTime()).toBe(
      base.getTime() + DIAS_APROVACAO_MAX * 86_400_000,
    );
    expect(calcularPrazoAprovacao(base, null).toISOString()).toBe('2026-11-24T12:00:00.000Z');
    expect(calcularPrazoAprovacao(base, 'abc').toISOString()).toBe('2026-11-24T12:00:00.000Z');
  });

  it('normalizarDiasAprovacao trunca e limita', () => {
    expect(normalizarDiasAprovacao(7.9)).toBe(7);
    expect(normalizarDiasAprovacao(-5)).toBe(1);
    expect(normalizarDiasAprovacao(366)).toBe(365);
    expect(normalizarDiasAprovacao(undefined)).toBe(7);
  });

  it('diasAprovacaoValido aceita só inteiros em [1, 365]', () => {
    expect(diasAprovacaoValido(1)).toBe(true);
    expect(diasAprovacaoValido(365)).toBe(true);
    expect(diasAprovacaoValido('7')).toBe(true);
    expect(diasAprovacaoValido(0)).toBe(false);
    expect(diasAprovacaoValido(366)).toBe(false);
    expect(diasAprovacaoValido(2.5)).toBe(false);
    expect(diasAprovacaoValido('')).toBe(false);
  });

  describe('situacaoAprovacao', () => {
    const prazo = '2026-11-24T12:00:00.000Z';

    it('resolvido → aguardando com o prazo', () => {
      const s = situacaoAprovacao(
        { status: StatusChamado.resolvido, fechar_automaticamente_em: prazo },
        [],
      );
      expect(s).toEqual({ tipo: 'aguardando', prazo: new Date(prazo) });
    });

    it('fechado por aprovação explícita', () => {
      const s = situacaoAprovacao({ status: StatusChamado.fechado }, [
        { tipo: 'chamado_resolvido', created_at: '2026-11-17T10:00:00Z' },
        { tipo: 'chamado_aprovado', created_at: '2026-11-18T10:00:00Z' },
      ]);
      expect(s).toEqual({
        tipo: 'aprovado',
        forma: 'explicita',
        em: new Date('2026-11-18T10:00:00Z'),
      });
    });

    it('fechado por aprovação tácita (prazo vencido)', () => {
      const s = situacaoAprovacao({ status: StatusChamado.fechado }, [
        { tipo: 'chamado_fechado_auto', created_at: '2026-11-24T12:05:00Z' },
      ]);
      expect(s).toMatchObject({ tipo: 'aprovado', forma: 'tacita' });
    });

    it('vale o ÚLTIMO fechamento (ciclos reabertos)', () => {
      const s = situacaoAprovacao({ status: StatusChamado.fechado }, [
        { tipo: 'chamado_aprovado', created_at: '2026-11-18T10:00:00Z' },
        { tipo: 'chamado_reaberto', created_at: '2026-11-19T10:00:00Z' },
        { tipo: 'chamado_fechado', created_at: '2026-11-20T10:00:00Z' },
      ]);
      expect(s).toEqual({ tipo: 'fechado_pela_equipe', em: new Date('2026-11-20T10:00:00Z') });
    });

    it('outros status → null', () => {
      for (const status of [
        StatusChamado.novo,
        StatusChamado.em_atendimento,
        StatusChamado.cancelado,
      ]) {
        expect(situacaoAprovacao({ status }, [])).toBeNull();
      }
    });
  });

  it('formatarPrazoAprovacao usa o fuso de Brasília', () => {
    // 02:30 UTC do dia 25 = 23:30 do dia 24 em Brasília (UTC−3).
    expect(formatarPrazoAprovacao('2026-11-25T02:30:00.000Z')).toContain('24 de novembro de 2026');
  });
});
