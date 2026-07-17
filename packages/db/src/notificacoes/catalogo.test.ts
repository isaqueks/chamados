import { describe, it, expect } from 'vitest';
import { CATALOGO_NOTIFICACOES, EventoNotificavel, defaultDoEvento, eObrigatorio } from './tipos';

/**
 * Defaults ANTI-FLOOD do catálogo (specs/06 §7, ajuste 2026-07-17): uma triagem
 * normal transita status/prioridade várias vezes em minutos — sem preferência
 * definida, esses eventos NÃO podem virar e-mail.
 */
describe('defaultDoEvento (anti-flood)', () => {
  it('eventos ruidosos nascem DESLIGADOS (opt-in)', () => {
    expect(defaultDoEvento(EventoNotificavel.mudanca_status)).toBe(false);
    expect(defaultDoEvento(EventoNotificavel.mudanca_prioridade)).toBe(false);
  });

  it('os demais eventos seguem ligados por default', () => {
    expect(defaultDoEvento(EventoNotificavel.chamado_criado)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.mensagem_publica)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.resolvido)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.reaberto)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.cancelado)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.fechado)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.atribuicao)).toBe(true);
  });

  it('nenhum evento OBRIGATÓRIO pode nascer desligado (coerência do catálogo)', () => {
    for (const evento of Object.keys(CATALOGO_NOTIFICACOES) as EventoNotificavel[]) {
      for (const papel of ['cliente', 'operador'] as const) {
        if (eObrigatorio(evento, papel)) {
          expect(defaultDoEvento(evento)).toBe(true);
        }
      }
    }
  });
});
