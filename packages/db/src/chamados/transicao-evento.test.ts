import { describe, it, expect } from 'vitest';
import { ATOR_SISTEMA, Papel, StatusChamado } from '@chamados/shared';
import { tipoEventoTransicao } from './chamado-service';

/**
 * Evento de auditoria por transição (specs/02 §tipo_evento) — com a janela de
 * aprovação do cliente (D-042): o PAPEL do ator distingue aprovação explícita,
 * aprovação tácita, fechamento manual, contestação e reabertura.
 */
const { resolvido, fechado, cancelado, em_atendimento, em_triagem } = StatusChamado;

describe('tipoEventoTransicao (D-042)', () => {
  it('cliente em resolvido → fechado = chamado_aprovado (explícita)', () => {
    expect(tipoEventoTransicao(Papel.cliente, resolvido, fechado)).toBe('chamado_aprovado');
  });

  it('sistema em resolvido → fechado = chamado_fechado_auto (aprovação tácita)', () => {
    expect(tipoEventoTransicao(ATOR_SISTEMA, resolvido, fechado)).toBe('chamado_fechado_auto');
  });

  it('operador/admin em resolvido → fechado = chamado_fechado (manual, não é aprovação)', () => {
    expect(tipoEventoTransicao(Papel.operador, resolvido, fechado)).toBe('chamado_fechado');
    expect(tipoEventoTransicao(Papel.admin, resolvido, fechado)).toBe('chamado_fechado');
  });

  it('cliente em resolvido → em_atendimento = chamado_contestado (no lugar de reaberto)', () => {
    expect(tipoEventoTransicao(Papel.cliente, resolvido, em_atendimento)).toBe(
      'chamado_contestado',
    );
  });

  it('equipe reabrindo resolvido e qualquer reabertura de encerrado = chamado_reaberto', () => {
    expect(tipoEventoTransicao(Papel.operador, resolvido, em_atendimento)).toBe('chamado_reaberto');
    expect(tipoEventoTransicao(Papel.cliente, fechado, em_atendimento)).toBe('chamado_reaberto');
    expect(tipoEventoTransicao(Papel.cliente, cancelado, em_atendimento)).toBe('chamado_reaberto');
  });

  it('demais transições não mudam', () => {
    expect(tipoEventoTransicao(Papel.operador, em_atendimento, resolvido)).toBe(
      'chamado_resolvido',
    );
    expect(tipoEventoTransicao(Papel.agente_ia, em_triagem, em_atendimento)).toBe(
      'status_alterado',
    );
  });
});
