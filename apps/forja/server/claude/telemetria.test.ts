import { describe, expect, it } from 'vitest';
import { lerFixture } from './fixtures/processo-falso';
import { normalizarStream, type ResultCli } from './stream';
import {
  calcularCustoTurno,
  condutorFezSozinho,
  deltaModelUsage,
  epocaParaIso,
  eventoTelemetriaTurno,
  eventoUsoAtualizado,
  extrairResultadoFinal,
  microUsd,
  modelosInesperados,
  resetsAtRejeitado,
  snapshotUso,
} from './telemetria';

const ctx = {
  execucaoId: 'e',
  etapaId: 's',
  papelPrincipal: 'condutor' as const,
  turno: 'T1' as const,
};

function results(fixture: 'a.jsonl' | 'b.jsonl' | 'c.jsonl'): ResultCli[] {
  return normalizarStream(lerFixture(fixture), ctx).sinais.flatMap((s) =>
    s.tipo === 'result' ? [s.result] : [],
  );
}

describe('telemetria do result (01 §6.5, 04 §9)', () => {
  it('extrai os campos do último result da fixture c', () => {
    const r = results('c.jsonl');
    const final = extrairResultadoFinal(r[r.length - 1]!);
    expect(final).toMatchObject({
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      structured_output: { palavra: 'banana', via_subagente: true },
      num_turns: 2,
      result_index: 1,
    });
    expect(final.total_cost_usd).toBeCloseTo(0.0315722);
    expect(final.subagent_stats).toMatchObject({ spawned: 1, completed: 1 });
  });

  it('custo do turno é o delta do acumulado na sessão (fixture b: 4 turnos)', () => {
    const r = results('b.jsonl').map(extrairResultadoFinal);
    const t0 = calcularCustoTurno(r[0]!, null);
    expect(t0.custo_usd).toBeCloseTo(0.013458);
    const t3 = calcularCustoTurno(r[3]!, {
      total_cost_usd: r[2]!.total_cost_usd,
      modelUsage: r[2]!.modelUsage,
    });
    expect(t3.custo_usd).toBeCloseTo(0.2024124 - 0.0145824, 6);
    // o Fable só aparece no 4º turno; o haiku, acumulado de antes, não mudou o custo neste turno
    expect(Object.keys(t3.model_usage_delta)).toContain('claude-fable-5-1');
    // sem acumulação na sessão (plano B do S5), o delta é o bruto
    expect(
      calcularCustoTurno(r[3]!, { total_cost_usd: 1, modelUsage: {} }, false).custo_usd,
    ).toBeCloseTo(0.2024124);
  });

  it('delta de modelUsage subtrai numéricos e omite modelo sem mudança', () => {
    const d = deltaModelUsage(
      {
        a: { inputTokens: 10, costUSD: 0.5, contextWindow: 200000 },
        b: { inputTokens: 5, costUSD: 0.1 },
      },
      {
        a: { inputTokens: 4, costUSD: 0.2, contextWindow: 200000 },
        b: { inputTokens: 5, costUSD: 0.1 },
      },
    );
    expect(d.a?.inputTokens).toBe(6);
    expect(d.a?.costUSD).toBeCloseTo(0.3);
    expect(d.b).toBeUndefined();
  });

  it('modelo inesperado e "condutor fez sozinho"', () => {
    expect(
      modelosInesperados({ 'claude-fable-5-1': {}, 'claude-haiku-4-5-20251001': {} }, [
        'claude-fable-5-1',
        'claude-opus-5-5',
      ]),
    ).toEqual(['claude-haiku-4-5-20251001']);
    expect(condutorFezSozinho(true, { 'claude-fable-5-1': {} }, 'claude-opus-5-5')).toBe(true);
    expect(condutorFezSozinho(true, { 'claude-opus-5-5': {} }, 'claude-opus-5-5')).toBe(false);
    expect(condutorFezSozinho(false, {}, 'claude-opus-5-5')).toBe(false);
  });

  it('evento telemetria.turno em micro-USD', () => {
    const final = extrairResultadoFinal(results('a.jsonl')[0]!);
    const ev = eventoTelemetriaTurno(
      { execucaoId: 'e', etapaId: 's' },
      final,
      calcularCustoTurno(final, null),
      'concluido',
    );
    expect(ev.tipo).toBe('telemetria.turno');
    expect(ev.tipo === 'telemetria.turno' && ev.dados.custo_micro_usd).toBe(microUsd(0.013466));
  });
});

describe('cota (rate_limit_event → uso_assinatura)', () => {
  it('snapshot das janelas da fixture a', () => {
    const sinal = normalizarStream(lerFixture('a.jsonl'), ctx).sinais.find(
      (s) => s.tipo === 'rate_limit',
    );
    expect(sinal?.tipo).toBe('rate_limit');
    if (sinal?.tipo !== 'rate_limit') return;
    const s = snapshotUso(sinal.info);
    expect(s).toMatchObject({
      utilizacao_5h: 0.02,
      utilizacao_7d: 0.17,
      status: 'allowed',
      status_overage: 'rejected',
      usando_creditos_extras: false,
    });
    expect(s.reinicia_5h_em).toBe(epocaParaIso(1790996400));
    const ev = eventoUsoAtualizado(s, false);
    expect(ev.tipo === 'uso.atualizado' && ev.dados.freio_ativo).toBe(false);
    expect(ev.execucao_id).toBeNull();
  });

  it('resetsAt só quando rejeitado', () => {
    expect(resetsAtRejeitado({ status: 'allowed', resetsAt: 1 })).toBeNull();
    expect(resetsAtRejeitado({ status: 'rejected', resetsAt: 1790996400 })).toBe(
      '2026-10-03T03:00:00.000Z',
    );
  });
});
