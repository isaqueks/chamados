import { describe, it, expect } from 'vitest';
import {
  CATALOGO_NOTIFICACOES,
  EventoNotificavel,
  defaultDoEvento,
  eObrigatorio,
  eventoNotificavelDe,
  eventosDoPapel,
} from './tipos';

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
    expect(defaultDoEvento(EventoNotificavel.aprovado)).toBe(true);
    expect(defaultDoEvento(EventoNotificavel.contestado)).toBe(true);
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

describe('janela de aprovação no catálogo (D-042)', () => {
  it('aprovação explícita e tácita viram o MESMO evento notificável (webhook `aprovado`)', () => {
    expect(eventoNotificavelDe('chamado_aprovado')).toBe(EventoNotificavel.aprovado);
    expect(eventoNotificavelDe('chamado_fechado_auto')).toBe(EventoNotificavel.aprovado);
    expect(CATALOGO_NOTIFICACOES.aprovado.webhook).toBe('aprovado');
  });

  it('fechamento manual pela equipe continua `fechado` (sem duplicar com `aprovado`)', () => {
    expect(eventoNotificavelDe('chamado_fechado')).toBe(EventoNotificavel.fechado);
    expect(CATALOGO_NOTIFICACOES.fechado.webhook).toBe('fechado');
  });

  it('contestação tem evento e webhook próprios; reabertura segue `status_alterado`', () => {
    expect(eventoNotificavelDe('chamado_contestado')).toBe(EventoNotificavel.contestado);
    expect(CATALOGO_NOTIFICACOES.contestado.webhook).toBe('contestado');
    expect(eventoNotificavelDe('chamado_reaberto')).toBe(EventoNotificavel.reaberto);
    expect(CATALOGO_NOTIFICACOES.reaberto.webhook).toBe('status_alterado');
  });

  it('contestação avisa só a equipe (quem contesta é sempre o solicitante) e é obrigatória para ela', () => {
    expect(CATALOGO_NOTIFICACOES.contestado.destinatarios).toEqual(['operador']);
    expect(eObrigatorio(EventoNotificavel.contestado, 'operador')).toBe(true);
    expect(eventosDoPapel('cliente')).not.toContain(EventoNotificavel.contestado);
    expect(eventosDoPapel('cliente')).toContain(EventoNotificavel.aprovado);
  });
});

describe('custo no catálogo (D-043)', () => {
  it('eventos de custo mapeiam para chaves notificáveis com webhook próprio', () => {
    expect(eventoNotificavelDe('estimativa_custo_alterada')).toBe(
      EventoNotificavel.estimativa_custo,
    );
    expect(CATALOGO_NOTIFICACOES.estimativa_custo.webhook).toBe('estimativa_custo_alterada');
    expect(eventoNotificavelDe('custo_final_definido')).toBe(EventoNotificavel.custo_final);
    expect(CATALOGO_NOTIFICACOES.custo_final.webhook).toBe('custo_final_definido');
  });

  it('estimativa é alteração de campo: opt-in (anti-flood), como prioridade', () => {
    expect(defaultDoEvento(EventoNotificavel.estimativa_custo)).toBe(false);
    expect(eObrigatorio(EventoNotificavel.estimativa_custo, 'cliente')).toBe(false);
  });

  it('correção do custo final nasce ligada (rara e muda o valor em aprovação), mas não é obrigatória', () => {
    expect(defaultDoEvento(EventoNotificavel.custo_final)).toBe(true);
    expect(eObrigatorio(EventoNotificavel.custo_final, 'cliente')).toBe(false);
  });

  it('o cliente pode configurar os dois na página de preferências', () => {
    expect(eventosDoPapel('cliente')).toContain(EventoNotificavel.estimativa_custo);
    expect(eventosDoPapel('cliente')).toContain(EventoNotificavel.custo_final);
  });

  it('complexidade continua sem notificação (interna)', () => {
    expect(eventoNotificavelDe('complexidade_alterada')).toBeNull();
  });
});
