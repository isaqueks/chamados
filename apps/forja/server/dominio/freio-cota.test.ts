import { describe, expect, it } from 'vitest';
import {
  acaoOverageEmCurso,
  avaliarFreio,
  bloqueiaInicio,
  decidirPausaCota,
  LIMIARES_PADRAO,
  montarCotaDto,
  podeRetomarPausaCota,
  type LeituraCota,
} from './freio-cota';
import { proximoEstado } from './maquina-execucao';

/** Freio de cota (specs/forja/03 §7.6; critério 03 §12.5). */

const AGORA = new Date('2026-10-02T10:00:00Z');
const RESET_5H = '2026-10-02T11:52:00.000Z';
const RESET_7D = '2026-10-05T00:00:00.000Z';

const leitura = (p: Partial<LeituraCota> = {}): LeituraCota => ({
  utilizacao_5h: 0.2,
  utilizacao_7d: 0.3,
  reinicia_5h_em: RESET_5H,
  reinicia_7d_em: RESET_7D,
  status: 'allowed',
  usando_creditos_extras: false,
  medido_em: '2026-10-02T09:59:00Z',
  ...p,
});

describe('avaliarFreio — limiares (03 §7.6)', () => {
  it('sem leitura ou abaixo dos limiares: livre', () => {
    expect(avaliarFreio(null, LIMIARES_PADRAO, AGORA).ativo).toBe(false);
    expect(avaliarFreio(leitura(), LIMIARES_PADRAO, AGORA).ativo).toBe(false);
    expect(avaliarFreio(leitura({ utilizacao_5h: 0.79 }), LIMIARES_PADRAO, AGORA).ativo).toBe(
      false,
    );
  });

  it('five_hour ≥ 0,80 freia até o resetsAt de 5 h', () => {
    const f = avaliarFreio(leitura({ utilizacao_5h: 0.8 }), LIMIARES_PADRAO, AGORA);
    expect(f).toMatchObject({ ativo: true, causas: ['five_hour'], ate: RESET_5H });
    expect(f.motivo).toContain('5 h ≥ 80%');
  });

  it('seven_day ≥ 0,90 freia até o reset de 7 dias; as duas → o mais tarde', () => {
    expect(avaliarFreio(leitura({ utilizacao_7d: 0.9 }), LIMIARES_PADRAO, AGORA)).toMatchObject({
      causas: ['seven_day'],
      ate: RESET_7D,
    });
    expect(
      avaliarFreio(leitura({ utilizacao_5h: 0.95, utilizacao_7d: 0.95 }), LIMIARES_PADRAO, AGORA),
    ).toMatchObject({ causas: ['five_hour', 'seven_day'], ate: RESET_7D });
  });

  it('libera no resetsAt sem esperar evento novo', () => {
    const l = leitura({ utilizacao_5h: 0.85 });
    expect(avaliarFreio(l, LIMIARES_PADRAO, new Date(RESET_5H)).ativo).toBe(false);
    expect(avaliarFreio(l, LIMIARES_PADRAO, new Date('2026-10-02T11:51:59Z')).ativo).toBe(true);
  });

  it('sem resetsAt conhecido, fica ativo sem "até"', () => {
    const f = avaliarFreio(
      leitura({ utilizacao_5h: 0.9, reinicia_5h_em: null }),
      LIMIARES_PADRAO,
      AGORA,
    );
    expect(f).toMatchObject({ ativo: true, ate: null });
    expect(f.motivo).not.toContain('até');
  });

  it('limiares do projeto valem', () => {
    expect(
      avaliarFreio(leitura({ utilizacao_5h: 0.6 }), { ...LIMIARES_PADRAO, five_hour: 0.5 }, AGORA)
        .ativo,
    ).toBe(true);
  });
});

describe('overage (U-8)', () => {
  it('não autorizado freia; autorizado não', () => {
    const l = leitura({ usando_creditos_extras: true, utilizacao_5h: 1 });
    expect(avaliarFreio(l, LIMIARES_PADRAO, AGORA)).toMatchObject({
      ativo: true,
      causas: expect.arrayContaining(['overage']),
    });
    expect(
      avaliarFreio(
        leitura({ usando_creditos_extras: true }),
        { ...LIMIARES_PADRAO, permitir_creditos_extras: true },
        AGORA,
      ).ativo,
    ).toBe(false);
  });

  it('libera no reset da janela esgotada', () => {
    const l = leitura({ usando_creditos_extras: true, utilizacao_7d: 1 });
    expect(avaliarFreio(l, LIMIARES_PADRAO, AGORA).ate).toBe(RESET_7D);
    expect(avaliarFreio(l, LIMIARES_PADRAO, new Date(RESET_7D)).ativo).toBe(false);
  });

  it('etapas em curso: só alertar (DECISÃO PENDENTE, default)', () => {
    expect(acaoOverageEmCurso(leitura({ usando_creditos_extras: true }), LIMIARES_PADRAO)).toBe(
      'alertar',
    );
    expect(acaoOverageEmCurso(leitura(), LIMIARES_PADRAO)).toBe('nenhuma');
  });
});

describe('bloqueiaInicio', () => {
  const freio = avaliarFreio(leitura({ utilizacao_5h: 0.9 }), LIMIARES_PADRAO, AGORA);

  it('bloqueia etapa de agente; verificação/integração seguem; conversa só avisa', () => {
    for (const e of ['planejar', 'implementar', 'revisar', 'relatar'] as const) {
      expect(bloqueiaInicio(freio, e)).toMatchObject({ bloqueia: true, ate: RESET_5H });
    }
    for (const e of ['verificar', 'evidenciar', 'integrar'] as const) {
      expect(bloqueiaInicio(freio, e)).toEqual({ bloqueia: false, aviso: null });
    }
    expect(bloqueiaInicio(freio, 'conversar')).toMatchObject({ bloqueia: false });
    expect(bloqueiaInicio(avaliarFreio(null, LIMIARES_PADRAO, AGORA), 'implementar').bloqueia).toBe(
      false,
    );
  });
});

describe('limite batido no meio → pausado_cota', () => {
  it('evento para a máquina e retoma_em do rejeitado', () => {
    const d = decidirPausaCota({
      resets_at_rejeitado: RESET_5H,
      leitura: leitura({ utilizacao_5h: 1, status: 'rejected' }),
      limiares: LIMIARES_PADRAO,
      agora: AGORA,
    });
    expect(d).toEqual({
      evento: { tipo: 'limite_cota', overage_nao_autorizado: false },
      retoma_em: RESET_5H,
    });
    const t = proximoEstado({ estado: 'implementando', estado_anterior: null }, d.evento);
    expect(t.tipo === 'transicao' && t.transicao.para).toBe('pausado_cota');
  });

  it('overage não autorizado vira motivo cota_overage', () => {
    const d = decidirPausaCota({
      resets_at_rejeitado: null,
      leitura: leitura({ usando_creditos_extras: true, utilizacao_5h: 1 }),
      limiares: LIMIARES_PADRAO,
      agora: AGORA,
    });
    expect(d.evento.overage_nao_autorizado).toBe(true);
    expect(d.retoma_em).toBe(RESET_5H);
    const t = proximoEstado({ estado: 'revisando', estado_anterior: null }, d.evento);
    expect(t.tipo === 'transicao' && t.transicao.motivo_estado).toBe('cota_overage');
  });

  it('retoma no resetsAt, mas não com o freio ativo por outra janela', () => {
    const livre = avaliarFreio(null, LIMIARES_PADRAO, AGORA);
    expect(podeRetomarPausaCota(RESET_5H, livre, AGORA)).toBe(false);
    expect(podeRetomarPausaCota(RESET_5H, livre, new Date(RESET_5H))).toBe(true);
    const freio7d = avaliarFreio(
      leitura({ utilizacao_7d: 0.95 }),
      LIMIARES_PADRAO,
      new Date(RESET_5H),
    );
    expect(podeRetomarPausaCota(RESET_5H, freio7d, new Date(RESET_5H))).toBe(false);
    expect(podeRetomarPausaCota(null, livre, AGORA)).toBe(true);
  });
});

describe('montarCotaDto (06 §1.2)', () => {
  it('espelha a leitura e o freio', () => {
    const dto = montarCotaDto(leitura({ utilizacao_5h: 0.85 }), LIMIARES_PADRAO, AGORA);
    expect(dto).toMatchObject({
      utilizacao_5h: 0.85,
      limiar_5h: 0.8,
      limiar_7d: 0.9,
      usando_creditos_extras: false,
      freio: { ativo: true, ate: RESET_5H },
    });
    expect(montarCotaDto(null, LIMIARES_PADRAO, AGORA)).toMatchObject({
      medido_em: null,
      freio: { ativo: false, motivo: null, ate: null },
    });
  });
});
