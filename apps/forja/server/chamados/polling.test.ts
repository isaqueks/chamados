import { describe, expect, it } from 'vitest';
import { montarNotaResolucaoPr, nomeBranchResolucao } from '@chamados/shared';
import {
  compararDetalhe,
  mensagensNovas,
  paraEventoSinal,
  PollingChamados,
  snapshotDoDetalhe,
  type AlvoPolling,
  type SinalChamado,
  type SnapshotChamado,
} from './polling';
import { montarNotaInicio } from './notas';
import { ChamadosFalso, detalheFalso, mensagemFalsa } from './servidor-falso.test-apoio';

/** Polling dos chamados em voo (specs/forja/07 §8): detalhe × snapshot → sinais tipados. */

const FORJA = { usuarioId: 'u-forja', nome: 'Equipe de Suporte' };

function detalhe(
  status: 'em_atendimento' | 'em_triagem' | 'cancelado' = 'em_atendimento',
  mensagens = [mensagemFalsa({ corpo: 'pedido' })],
  ia_silenciada = true,
) {
  return { chamado: detalheFalso({ numero: 12, status, ia_silenciada }), mensagens };
}

describe('compararDetalhe', () => {
  it('sem snapshot anterior só estabelece a base', () => {
    const d = detalhe();
    const r = compararDetalhe(null, d, FORJA);
    expect(r.sinais).toEqual([]);
    expect(r.snapshot).toMatchObject({
      status: 'em_atendimento',
      ultima_mensagem_id: d.mensagens[0]!.id,
    });
  });

  it('cliente respondeu (pergunta → em_triagem): sinais cliente_respondeu + status_mudou', () => {
    const base = detalhe('em_atendimento');
    const anterior = { ...snapshotDoDetalhe(base), status: 'aguardando_cliente' as const };
    const resposta = mensagemFalsa({ corpo: 'Sim, obrigatório.' });
    const r = compararDetalhe(
      anterior,
      detalhe('em_triagem', [...base.mensagens, resposta]),
      FORJA,
    );
    const tipos = r.sinais.map((s) => s.tipo);
    expect(tipos).toEqual(['status_mudou', 'cliente_respondeu']);
    expect(r.sinais[0]).toMatchObject({
      de: 'aguardando_cliente',
      para: 'em_triagem',
      terminal: false,
    });
    expect((r.sinais[1] as Extract<SinalChamado, { tipo: 'cliente_respondeu' }>).mensagens).toEqual(
      [resposta],
    );
  });

  it('ia reativada, nota da IA e PR da IA novo', () => {
    const base = detalhe();
    const anterior = snapshotDoDetalhe(base);
    const pr = mensagemFalsa({
      corpo: montarNotaResolucaoPr({
        branch: nomeBranchResolucao(12, 'Frete'),
        prUrl: null,
        resumo: 'x',
        arquivos: [],
      }),
      visibilidade: 'interna',
      autor_papel: 'agente_ia',
      autor_nome: 'Assistente IA',
    });
    const r = compararDetalhe(
      anterior,
      detalhe('em_atendimento', [...base.mensagens, pr], false),
      FORJA,
    );
    expect(r.sinais.map((s) => s.tipo)).toEqual(['ia_reativada', 'nota_ia', 'pr_ia_apareceu']);
    expect(r.snapshot.branch_ia).toBe('ia/chamado-12-frete');
    // Na próxima leitura o mesmo PR não dispara de novo.
    expect(
      compararDetalhe(r.snapshot, detalhe('em_atendimento', [...base.mensagens, pr], false), FORJA)
        .sinais,
    ).toEqual([]);
  });

  it('mensagens da própria Forja (nome ou marcador) e de outro humano', () => {
    const base = detalhe();
    const anterior = snapshotDoDetalhe(base);
    const minha = mensagemFalsa({ corpo: 'Olá!', autor_nome: FORJA.nome, autor_papel: 'operador' });
    const nota = mensagemFalsa({
      corpo: montarNotaInicio({ execucaoId: 'e1', branch: 'b' }),
      autor_nome: 'Renomeado',
      autor_papel: 'operador',
      visibilidade: 'interna',
    });
    const colega = mensagemFalsa({
      corpo: 'Vi isso.',
      autor_nome: 'Ana',
      autor_papel: 'operador',
      visibilidade: 'interna',
    });
    const r = compararDetalhe(
      anterior,
      detalhe('em_atendimento', [...base.mensagens, minha, nota, colega]),
      FORJA,
    );
    expect(r.sinais).toEqual([{ tipo: 'mensagem_equipe', mensagens: [colega] }]);
  });

  it('status terminal marca terminal', () => {
    const base = detalhe();
    const r = compararDetalhe(snapshotDoDetalhe(base), detalhe('cancelado', base.mensagens), FORJA);
    expect(r.sinais).toEqual([
      { tipo: 'status_mudou', de: 'em_atendimento', para: 'cancelado', terminal: true },
    ]);
  });

  it('mensagensNovas: depois do id; id sumido cai na data; base sem mensagens = todas', () => {
    const a = mensagemFalsa({ corpo: 'a', created_at: '2026-10-02T10:00:00.000Z' });
    const b = mensagemFalsa({ corpo: 'b', created_at: '2026-10-02T11:00:00.000Z' });
    const snap = (id: string | null, em: string | null): SnapshotChamado => ({
      status: 'em_atendimento',
      ia_silenciada: true,
      ultima_mensagem_id: id,
      ultima_mensagem_em: em,
      branch_ia: null,
    });
    expect(mensagensNovas(snap(a.id, null), [a, b])).toEqual([b]);
    expect(mensagensNovas(snap('sumiu', '2026-10-02T10:30:00.000Z'), [a, b])).toEqual([b]);
    expect(mensagensNovas(snap(null, null), [a, b])).toEqual([a, b]);
  });

  it('paraEventoSinal mapeia para o protocolo do SSE', () => {
    expect(
      paraEventoSinal(
        {
          tipo: 'pr_ia_apareceu',
          pr: { branch: 'ia/chamado-1-x', numero_na_branch: 1, pr_url: null },
        },
        1,
      ).sinal,
    ).toBe('pr_ia_detectado');
    expect(paraEventoSinal({ tipo: 'nota_ia', notas: [] }, 1).sinal).toBe('mensagem_nova');
  });
});

describe('PollingChamados', () => {
  function montar() {
    const s = new ChamadosFalso();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      s.adicionar({
        detalhe: detalheFalso({ numero: n, id: `uuid-${n}` }),
        mensagens: [mensagemFalsa({ corpo: 'pedido' })],
      });
    }
    const salvos = new Map<string, SnapshotChamado>();
    const emitidos: Array<[number, SinalChamado[]]> = [];
    let valida = true;
    let emVoo = 0;
    let maxEmVoo = 0;
    const api = s.cliente();
    const polling = new PollingChamados({
      api: {
        obterChamado: async (ref, o) => {
          emVoo += 1;
          maxEmVoo = Math.max(maxEmVoo, emVoo);
          await new Promise((r) => setTimeout(r, 1));
          try {
            return await api.obterChamado(ref, o);
          } finally {
            emVoo -= 1;
          }
        },
      },
      listarEmVoo: async () =>
        [...s.chamados.values()].map<AlvoPolling>((c) => ({
          chamado_ref: c.detalhe.id,
          numero: c.detalhe.numero,
          snapshot: salvos.get(c.detalhe.id) ?? null,
        })),
      salvar: async (alvo, snap) => void salvos.set(alvo.chamado_ref, snap),
      emitir: (alvo, sinais) => void emitidos.push([alvo.numero, sinais]),
      identidade: () => FORJA,
      conexaoValida: () => valida,
      aleatorio: () => 1,
    });
    return {
      s,
      polling,
      salvos,
      emitidos,
      maxEmVoo: () => maxEmVoo,
      invalidar: () => (valida = false),
    };
  }

  it('rodada lê o detalhe em markdown com concorrência 4 e emite só o que mudou', async () => {
    const m = montar();
    await m.polling.rodada();
    expect(m.salvos.size).toBe(6);
    expect(m.emitidos).toEqual([]);
    expect(m.maxEmVoo()).toBeLessThanOrEqual(4);
    expect(m.s.requisicoes.every((r) => r.query.get('formato') === 'markdown')).toBe(true);

    m.s.chamados.get('uuid-3')!.mensagens.push(mensagemFalsa({ corpo: 'novidade' }));
    await m.polling.rodada();
    expect(m.emitidos.map(([n, s]) => [n, s.map((x) => x.tipo)])).toEqual([
      [3, ['cliente_respondeu']],
    ]);
  });

  it('404 → chamado_inacessivel; conexão inválida pausa sem chamar a API', async () => {
    const m = montar();
    const r = await m.polling.verificar({ chamado_ref: 'sumiu', numero: 99, snapshot: null });
    expect(r.sinais).toEqual([{ tipo: 'chamado_inacessivel' }]);
    m.invalidar();
    const antes = m.s.requisicoes.length;
    expect(await m.polling.rodada()).toEqual([]);
    expect(m.s.requisicoes.length).toBe(antes);
  });

  it('intervalo de 3 min com jitter de ±20 %', () => {
    const mk = (r: number) =>
      new PollingChamados({
        api: { obterChamado: async () => detalhe() },
        listarEmVoo: async () => [],
        salvar: async () => undefined,
        emitir: () => undefined,
        identidade: () => null,
        conexaoValida: () => true,
        aleatorio: () => r,
      }).proximoIntervalo();
    expect(mk(0)).toBe(144_000);
    expect(mk(0.5)).toBe(180_000);
    expect(mk(1)).toBe(216_000);
  });

  it('iniciar/parar usam o agendador injetado', async () => {
    const agendados: Array<() => void> = [];
    let cancelados = 0;
    const p = new PollingChamados({
      api: { obterChamado: async () => detalhe() },
      listarEmVoo: async () => [],
      salvar: async () => undefined,
      emitir: () => undefined,
      identidade: () => null,
      conexaoValida: () => true,
      agendar: (fn) => {
        agendados.push(fn);
        return () => (cancelados += 1);
      },
    });
    p.iniciar();
    expect(agendados).toHaveLength(1);
    agendados[0]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(agendados).toHaveLength(2);
    p.parar();
    expect(cancelados).toBe(1);
  });
});
