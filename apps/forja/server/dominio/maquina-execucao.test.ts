import { describe, expect, it } from 'vitest';
import {
  EstadoExecucao,
  MotivoEstado,
  valores,
  type EstadoExecucao as TEstado,
  type MotivoEstado as TMotivo,
} from '../../comum/estados';
import {
  aplicarTransicao,
  destinosPossiveis,
  ESTADO_ANTERIOR,
  MOTIVOS_OBSOLETOS,
  proximoEstado,
  TRANSICOES,
  transicaoValida,
  type AtorTransicao,
  type DecisaoMaquina,
  type EstadoAtualExecucao,
  type EventoMaquina,
} from './maquina-execucao';

/**
 * Critério de aceite 03 §12.1: toda transição de §2.4 aceita com a condição
 * verdadeira e recusada sem ela; nenhuma transição fora da tabela.
 *
 * A tabela ESPERADA abaixo é escrita à mão a partir da spec (03 §2.3, §2.4,
 * §6, §10, §11), independente de `TRANSICOES`: o teste exaustivo compara as
 * duas em todos os pares (de, para, ator).
 */

const ESTADOS = valores(EstadoExecucao);
const MOTIVOS = valores(MotivoEstado);
const ATORES: AtorTransicao[] = ['codigo', 'humano'];
const LATERAIS: TEstado[] = [
  'pausado_usuario',
  'pausado_cota',
  'assumido_manual',
  'interrompido',
  'falhou',
];
/** Anterior fixo dos laterais no teste exaustivo (saídas por `estado_anterior` voltam para cá). */
const ANTERIOR: TEstado = 'implementando';

const PRE_MERGE: TEstado[] = [
  'na_fila',
  'preparando',
  'planejando',
  'plano_pronto',
  'aguardando_plano',
  'aguardando_decisao',
  'aguardando_cliente_resposta',
  'implementando',
  'verificando',
  'revisando',
  'relatando',
  'aguardando_aprovacao',
  'retrabalho_humano',
  'na_fila_merge',
  'integrando',
  'resolvendo_conflito',
  'precisa_humano',
  ...LATERAIS,
];
const ANTES_IMPL: TEstado[] = [
  'na_fila',
  'preparando',
  'planejando',
  'plano_pronto',
  'aguardando_plano',
  'aguardando_decisao',
  'aguardando_cliente_resposta',
];
const COM_AGENTE: TEstado[] = [
  'planejando',
  'implementando',
  'revisando',
  'relatando',
  'resolvendo_conflito',
];
const COM_PROCESSO: TEstado[] = ['preparando', ...COM_AGENTE, 'verificando', 'integrando'];

type Linha = [de: TEstado | TEstado[], para: TEstado, atores: AtorTransicao[]];

const ESPERADO: Linha[] = [
  ['na_fila', 'preparando', ['codigo']],
  ['preparando', 'planejando', ['codigo']],
  ['preparando', 'precisa_humano', ['codigo']],
  ['preparando', 'falhou', ['codigo']],
  ['planejando', 'plano_pronto', ['codigo']],
  ['plano_pronto', 'precisa_humano', ['codigo']],
  ['plano_pronto', 'aguardando_decisao', ['codigo']],
  ['plano_pronto', 'aguardando_plano', ['codigo']],
  ['plano_pronto', 'implementando', ['codigo']],
  ['aguardando_decisao', 'aguardando_cliente_resposta', ['humano']],
  ['aguardando_decisao', 'planejando', ['humano']],
  ['aguardando_decisao', 'precisa_humano', ['codigo']],
  ['aguardando_cliente_resposta', 'planejando', ['humano']],
  ['aguardando_cliente_resposta', 'precisa_humano', ['codigo']],
  ['aguardando_plano', 'implementando', ['humano']],
  ['aguardando_plano', 'planejando', ['humano']],
  ['implementando', 'verificando', ['codigo']],
  ['implementando', 'precisa_humano', ['codigo']],
  ['verificando', 'revisando', ['codigo']],
  ['verificando', 'precisa_humano', ['codigo']],
  ['verificando', 'falhou', ['codigo']],
  ['revisando', 'relatando', ['codigo']],
  ['revisando', 'implementando', ['codigo']],
  ['revisando', 'precisa_humano', ['codigo']],
  ['relatando', 'aguardando_aprovacao', ['codigo']],
  ['relatando', 'precisa_humano', ['codigo']],
  ['aguardando_aprovacao', 'na_fila_merge', ['humano']],
  ['aguardando_aprovacao', 'retrabalho_humano', ['humano']],
  ['aguardando_aprovacao', 'assumido_manual', ['humano']],
  ['retrabalho_humano', 'implementando', ['codigo']],
  ['na_fila_merge', 'integrando', ['codigo']],
  ['integrando', 'mergeado', ['codigo']],
  ['integrando', 'aguardando_aprovacao', ['codigo']],
  ['integrando', 'implementando', ['codigo']],
  ['integrando', 'precisa_humano', ['codigo']],
  ['integrando', 'falhou', ['codigo']],
  // FJ-036: resolução automática de conflito
  ['integrando', 'resolvendo_conflito', ['codigo']],
  ['resolvendo_conflito', 'verificando', ['codigo']],
  ['resolvendo_conflito', 'precisa_humano', ['codigo']],
  ['precisa_humano', 'resolvendo_conflito', ['humano']],
  ['mergeado', 'comunicando', ['codigo']],
  ['comunicando', 'aguardando_deploy', ['codigo']],
  ['aguardando_deploy', 'comunicando', ['humano']],
  ['comunicando', 'mergeado_pendente_chamado', ['codigo']],
  ['mergeado_pendente_chamado', 'comunicando', ['codigo', 'humano']],
  ['comunicando', 'concluido', ['codigo']],
  ['precisa_humano', 'implementando', ['humano']],
  ['precisa_humano', 'relatando', ['humano']],
  ['precisa_humano', 'planejando', ['humano']],
  ['precisa_humano', 'aguardando_aprovacao', ['humano']],
  ['precisa_humano', 'na_fila_merge', ['humano']],
  ['precisa_humano', 'verificando', ['humano']],
  ['precisa_humano', 'revisando', ['humano']],
  ['precisa_humano', 'assumido_manual', ['humano']],
  // genéricas
  [PRE_MERGE, 'descartado', ['humano']],
  [PRE_MERGE, 'cancelado', ['humano']],
  [
    PRE_MERGE.filter((e) => e !== 'assumido_manual' && e !== 'precisa_humano'),
    'precisa_humano',
    ['codigo'],
  ],
  [ANTES_IMPL, 'precisa_humano', ['codigo']],
  // laterais
  [COM_PROCESSO, 'pausado_usuario', ['humano']],
  ['pausado_usuario', ANTERIOR, ['humano']],
  [COM_AGENTE, 'pausado_cota', ['codigo']],
  ['pausado_cota', ANTERIOR, ['codigo', 'humano']],
  [[...COM_AGENTE, 'pausado_usuario', 'falhou'], 'assumido_manual', ['humano']],
  ['assumido_manual', 'verificando', ['humano']],
  [COM_PROCESSO, 'interrompido', ['codigo']],
  ['interrompido', ANTERIOR, ['codigo', 'humano']],
  ['interrompido', 'precisa_humano', ['codigo']],
  [['preparando', 'plano_pronto', 'retrabalho_humano', ...COM_AGENTE], 'falhou', ['codigo']],
  ['falhou', ANTERIOR, ['humano']],
];

const esperado = new Set<string>();
for (const [de, para, atores] of ESPERADO) {
  for (const d of Array.isArray(de) ? de : [de]) {
    for (const a of atores) if (d !== para) esperado.add(`${d}>${para}:${a}`);
  }
}

/** Aceita com ALGUM motivo (null ou da lista fechada)? */
function aceitaAlgum(de: TEstado, para: TEstado, ator: AtorTransicao): boolean {
  const anterior = LATERAIS.includes(de) ? ANTERIOR : null;
  return [null, ...MOTIVOS].some(
    (motivo) => transicaoValida(de, para, ator, { estado_anterior: anterior, motivo }).valida,
  );
}

describe('tabela de transições (03 §2.4) — exaustivo', () => {
  it('nenhuma transição fora da tabela e nenhuma da tabela faltando', () => {
    const obtido = new Set<string>();
    for (const de of ESTADOS) {
      for (const para of ESTADOS) {
        for (const ator of ATORES) {
          if (aceitaAlgum(de, para, ator)) obtido.add(`${de}>${para}:${ator}`);
        }
      }
    }
    expect([...obtido].filter((x) => !esperado.has(x)).sort()).toEqual([]);
    expect([...esperado].filter((x) => !obtido.has(x)).sort()).toEqual([]);
  });

  it('toda regra de TRANSICOES é aceita para cada origem e ator, com motivo da lista', () => {
    for (const regra of TRANSICOES) {
      for (const de of regra.de) {
        const anterior = LATERAIS.includes(de) ? ANTERIOR : null;
        const para = regra.para === ESTADO_ANTERIOR ? ANTERIOR : regra.para;
        if (para === de) continue;
        for (const ator of regra.atores) {
          const motivo = regra.motivos?.[0] ?? null;
          const r = transicaoValida(de, para, ator, { estado_anterior: anterior, motivo });
          expect(r.valida, `${regra.id} de ${de} por ${ator}`).toBe(true);
        }
      }
    }
  });

  it('terminais não saem; resolvendo_conflito só a partir da integração ou do humano (FJ-036)', () => {
    for (const t of ['concluido', 'descartado', 'cancelado'] as TEstado[]) {
      expect(destinosPossiveis(t)).toEqual([]);
      expect(transicaoValida(t, 'na_fila', 'humano').valida).toBe(false);
    }
    const chegam = ESTADOS.filter((de) =>
      destinosPossiveis(de, LATERAIS.includes(de) ? 'resolvendo_conflito' : null).includes(
        'resolvendo_conflito',
      ),
    ).filter((de) => !LATERAIS.includes(de));
    expect(chegam.sort()).toEqual(['integrando', 'precisa_humano']);
    // Nunca pula a coleta/revisão/relatório: a resolução sempre volta pela coleta.
    expect(destinosPossiveis('resolvendo_conflito').sort()).toEqual(
      [
        'assumido_manual',
        'cancelado',
        'descartado',
        'falhou',
        'interrompido',
        'pausado_cota',
        'pausado_usuario',
        'precisa_humano',
        'verificando',
      ].sort(),
    );
  });

  it('depois de mergeado não há descarte nem volta (03 §2.5)', () => {
    for (const de of [
      'mergeado',
      'comunicando',
      'mergeado_pendente_chamado',
      'aguardando_deploy',
    ]) {
      expect(transicaoValida(de as TEstado, 'descartado', 'humano').valida).toBe(false);
      expect(transicaoValida(de as TEstado, 'implementando', 'codigo').valida).toBe(false);
    }
  });

  it('ator errado é recusado com mensagem de quem decide', () => {
    const r = transicaoValida('na_fila', 'preparando', 'humano');
    expect(r).toMatchObject({ valida: false });
    if (!r.valida) expect(r.erro).toContain('codigo');
    expect(transicaoValida('aguardando_plano', 'implementando', 'codigo').valida).toBe(false);
  });
});

describe('motivo_estado (lista fechada, 02 §2.2)', () => {
  it('precisa_humano/falhou/cancelado exigem motivo', () => {
    expect(transicaoValida('plano_pronto', 'precisa_humano', 'codigo').valida).toBe(false);
    expect(transicaoValida('verificando', 'falhou', 'codigo').valida).toBe(false);
    expect(transicaoValida('na_fila', 'cancelado', 'humano').valida).toBe(false);
  });

  it('motivo fora da lista da transição é recusado', () => {
    expect(
      transicaoValida('plano_pronto', 'precisa_humano', 'codigo', { motivo: 'base_vermelha' })
        .valida,
    ).toBe(false);
    expect(
      transicaoValida('verificando', 'falhou', 'codigo', { motivo: 'saida_invalida' }).valida,
    ).toBe(false);
    expect(
      transicaoValida('implementando', 'precisa_humano', 'codigo', {
        motivo: 'ia_servidor_ativa',
      }).valida,
    ).toBe(false);
  });

  it('motivo em destino que não leva motivo é recusado; pausado_cota aceita cota_overage', () => {
    expect(
      transicaoValida('na_fila', 'preparando', 'codigo', { motivo: 'base_vermelha' }).valida,
    ).toBe(false);
    expect(
      transicaoValida('implementando', 'pausado_cota', 'codigo', { motivo: 'cota_overage' }).valida,
    ).toBe(true);
    expect(transicaoValida('implementando', 'pausado_cota', 'codigo').valida).toBe(true);
  });

  it('cada motivo da lista fechada tem pelo menos uma transição que o aceita', () => {
    const usados = new Set(TRANSICOES.flatMap((t) => t.motivos ?? []));
    expect(MOTIVOS.filter((m) => !usados.has(m) && !MOTIVOS_OBSOLETOS.includes(m))).toEqual([]);
    // Os obsoletos (FJ-032) não são escritos por nenhuma transição.
    expect(MOTIVOS_OBSOLETOS.filter((m) => usados.has(m))).toEqual([]);
  });
});

describe('laterais e estado_anterior (03 §2.3; I-9)', () => {
  const em = (estado: TEstado, anterior: TEstado | null = null): EstadoAtualExecucao => ({
    estado,
    estado_anterior: anterior,
  });

  it('entrar em lateral grava o estado de origem', () => {
    const r = aplicarTransicao(em('revisando'), 'pausado_usuario', 'humano');
    expect(r.ok && r.transicao.estado_anterior).toBe('revisando');
  });

  it('lateral → lateral preserva o anterior original (pausado → assumido)', () => {
    const r = aplicarTransicao(em('pausado_usuario', 'relatando'), 'assumido_manual', 'humano');
    expect(r.ok && r.transicao.estado_anterior).toBe('relatando');
  });

  it('saída para estado_anterior só para o anterior gravado, e limpa o anterior', () => {
    expect(
      transicaoValida('pausado_usuario', 'revisando', 'humano', { estado_anterior: 'revisando' })
        .valida,
    ).toBe(true);
    expect(
      transicaoValida('pausado_usuario', 'relatando', 'humano', { estado_anterior: 'revisando' })
        .valida,
    ).toBe(false);
    const r = aplicarTransicao(em('falhou', 'verificando'), 'verificando', 'humano');
    expect(r.ok && r.transicao.estado_anterior).toBeNull();
  });

  it('lateral sem estado_anterior é recusado (I-9); anterior lateral/terminal também', () => {
    expect(transicaoValida('pausado_usuario', 'descartado', 'humano').valida).toBe(false);
    expect(
      transicaoValida('falhou', 'descartado', 'humano', { estado_anterior: 'pausado_cota' }).valida,
    ).toBe(false);
    expect(
      transicaoValida('falhou', 'descartado', 'humano', { estado_anterior: 'concluido' }).valida,
    ).toBe(false);
  });
});

describe('aplicarTransicao — efeitos e origem', () => {
  const ap = (estado: TEstado, para: TEstado, ator: AtorTransicao, motivo?: TMotivo) => {
    const r = aplicarTransicao({ estado, estado_anterior: null }, para, ator, { motivo });
    if (!r.ok) throw new Error(r.erro);
    return r.transicao;
  };

  it('retrabalho automático conta auto e total; humano só total (03 §6)', () => {
    expect(ap('revisando', 'implementando', 'codigo').efeitos).toMatchObject({
      ciclo_auto: 1,
      ciclo_total: 1,
    });
    expect(ap('retrabalho_humano', 'implementando', 'codigo').efeitos).toMatchObject({
      ciclo_auto: 0,
      ciclo_total: 1,
    });
    expect(ap('integrando', 'implementando', 'codigo').efeitos.ciclo_total).toBe(1);
    expect(ap('precisa_humano', 'implementando', 'humano').efeitos.ciclo_total).toBe(1);
    const devolver = aplicarTransicao(
      { estado: 'assumido_manual', estado_anterior: 'implementando' },
      'verificando',
      'humano',
    );
    expect(devolver.ok && devolver.transicao.efeitos.ciclo_total).toBe(1);
  });

  it('primeira implementação vem de plano_pronto ou G1; token schema solto só nos terminais/mergeado', () => {
    expect(ap('plano_pronto', 'implementando', 'codigo').efeitos.primeira_implementacao).toBe(true);
    expect(ap('aguardando_plano', 'implementando', 'humano').efeitos.primeira_implementacao).toBe(
      true,
    );
    expect(ap('revisando', 'implementando', 'codigo').efeitos.primeira_implementacao).toBe(false);
    expect(ap('integrando', 'mergeado', 'codigo').efeitos.solta_token_schema).toBe(true);
    expect(ap('implementando', 'descartado', 'humano').efeitos.solta_token_schema).toBe(true);
    expect(
      ap('implementando', 'precisa_humano', 'codigo', 'timeout_etapa').efeitos.solta_token_schema,
    ).toBe(false);
  });

  it('origem do evento: modelo quando "modelo produz, código valida"', () => {
    expect(ap('planejando', 'plano_pronto', 'codigo').origem).toBe('modelo');
    expect(ap('na_fila', 'preparando', 'codigo').origem).toBe('codigo');
    expect(ap('aguardando_plano', 'planejando', 'humano').origem).toBe('humano');
  });

  it('motivo_texto só acompanha motivo', () => {
    const r = aplicarTransicao(
      { estado: 'na_fila', estado_anterior: null },
      'preparando',
      'codigo',
      {
        motivo_texto: 'x',
      },
    );
    expect(r.ok && r.transicao.motivo_texto).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// proximoEstado: cada fato com a condição verdadeira e falsa
// ---------------------------------------------------------------------------

function para(d: DecisaoMaquina): TEstado | 'permanece' | 'recusado' {
  return d.tipo === 'transicao' ? d.transicao.para : d.tipo;
}
function motivo(d: DecisaoMaquina): TMotivo | null {
  return d.tipo === 'transicao' ? d.transicao.motivo_estado : null;
}
const at = (
  estado: TEstado,
  anterior: TEstado | null = null,
  m: TMotivo | null = null,
): EstadoAtualExecucao => ({ estado, estado_anterior: anterior, motivo_estado: m });

describe('proximoEstado — fatos do código', () => {
  const iniciar = {
    tipo: 'tentar_iniciar',
    vaga_livre: true,
    freio_liberado: true,
    ordem_lote_ok: true,
    cli_compativel: true,
  } as const;

  it('na_fila → preparando só com todas as condições', () => {
    expect(para(proximoEstado(at('na_fila'), iniciar))).toBe('preparando');
    for (const k of ['vaga_livre', 'freio_liberado', 'ordem_lote_ok', 'cli_compativel'] as const) {
      expect(para(proximoEstado(at('na_fila'), { ...iniciar, [k]: false }))).toBe('permanece');
    }
    expect(para(proximoEstado(at('planejando'), iniciar))).toBe('recusado');
  });

  it('preparo: pré-condição → humano; setup/worktree → falhou; base vermelha → humano; ok → planejando', () => {
    const base = {
      tipo: 'preparo_concluido',
      pre_condicoes: { ok: true },
      worktree_ok: true,
    } as const;
    expect(para(proximoEstado(at('preparando'), base))).toBe('planejando');
    const pc = proximoEstado(at('preparando'), {
      ...base,
      pre_condicoes: { ok: false, motivo: 'ia_servidor_ativa' },
    });
    expect([para(pc), motivo(pc)]).toEqual(['precisa_humano', 'ia_servidor_ativa']);
    // FJ-032: sem setup nem linha de base — só a worktree pode falhar no preparo.
    const st = proximoEstado(at('preparando'), { ...base, worktree_ok: false });
    expect([para(st), motivo(st)]).toEqual(['falhou', 'setup_falhou']);
    const f = proximoEstado(at('preparando'), base);
    expect(f.tipo === 'transicao' && f.transicao.estado_anterior).toBeNull();
    const lat = proximoEstado(at('preparando'), { ...base, worktree_ok: false });
    expect(lat.tipo === 'transicao' && lat.transicao.estado_anterior).toBe('preparando');
  });

  it('plano produzido: só com result, zod e regras ok', () => {
    const ok = {
      tipo: 'plano_produzido',
      result_sem_erro: true,
      contrato_valido: true,
      regras_ok: true,
    } as const;
    expect(para(proximoEstado(at('planejando'), ok))).toBe('plano_pronto');
    for (const k of ['result_sem_erro', 'contrato_valido', 'regras_ok'] as const) {
      expect(para(proximoEstado(at('planejando'), { ...ok, [k]: false }))).toBe('recusado');
    }
  });

  it('plano avaliado aplica a decisão do gate e recusa destino fora da tabela', () => {
    for (const d of ['aguardando_decisao', 'aguardando_plano', 'implementando'] as const) {
      expect(
        para(proximoEstado(at('plano_pronto'), { tipo: 'plano_avaliado', decisao: { para: d } })),
      ).toBe(d);
    }
    expect(
      para(
        proximoEstado(at('plano_pronto'), {
          tipo: 'plano_avaliado',
          decisao: { para: 'precisa_humano', motivo: 'nao_implementavel' },
        }),
      ),
    ).toBe('precisa_humano');
    expect(
      para(
        proximoEstado(at('plano_pronto'), {
          tipo: 'plano_avaliado',
          decisao: { para: 'verificando' },
        }),
      ),
    ).toBe('recusado');
  });

  it('T1 concluído: bloqueio/diff vazio → humano; sem commit ou result → recusado; ok → verificando', () => {
    const ok = {
      tipo: 'implementacao_concluida',
      result_sem_erro: true,
      contrato_valido: true,
      commit_feito: true,
      diff_vazio: false,
      bloqueios: [],
    } as const;
    expect(para(proximoEstado(at('implementando'), ok))).toBe('verificando');
    expect(para(proximoEstado(at('implementando'), { ...ok, diff_vazio: true }))).toBe(
      'precisa_humano',
    );
    // FJ-033 no T1: bloqueio comum vira suposição (segue); só "sem suposição" para.
    expect(
      para(
        proximoEstado(at('implementando'), {
          ...ok,
          bloqueios: ['decisao_do_operador: Adotado: aceitar a rolagem'],
        }),
      ),
    ).toBe('verificando');
    expect(
      para(
        proximoEstado(at('implementando'), {
          ...ok,
          bloqueios: ['informacao_do_cliente: sem suposição: apagar dados de produção?'],
        }),
      ),
    ).toBe('precisa_humano');
    expect(para(proximoEstado(at('implementando'), { ...ok, commit_feito: false }))).toBe(
      'recusado',
    );
    expect(para(proximoEstado(at('implementando'), { ...ok, result_sem_erro: false }))).toBe(
      'recusado',
    );
  });

  it('decisões de verificação, veredito e relatório só no estado certo', () => {
    expect(
      para(
        proximoEstado(at('verificando'), {
          tipo: 'verificacao_concluida',
          decisao: { para: 'revisando' },
        }),
      ),
    ).toBe('revisando');
    expect(
      para(
        proximoEstado(at('revisando'), {
          tipo: 'verificacao_concluida',
          decisao: { para: 'revisando' },
        }),
      ),
    ).toBe('recusado');
    expect(
      para(
        proximoEstado(at('revisando'), {
          tipo: 'veredito_avaliado',
          decisao: { para: 'relatando' },
        }),
      ),
    ).toBe('relatando');
    expect(
      para(
        proximoEstado(at('relatando'), {
          tipo: 'relatorio_avaliado',
          decisao: { para: 'precisa_humano', motivo: 'relatorio_incoerente' },
        }),
      ),
    ).toBe('precisa_humano');
    expect(
      para(
        proximoEstado(at('verificando'), {
          tipo: 'verificacao_concluida',
          decisao: { para: 'relatando' },
        }),
      ),
    ).toBe('recusado');
  });

  it('retrabalho humano sempre vira T1', () => {
    expect(para(proximoEstado(at('retrabalho_humano'), { tipo: 'retrabalho_iniciado' }))).toBe(
      'implementando',
    );
  });

  it('vez na fila de merge: próximo ∧ semáforo livre ∧ fila destravada', () => {
    const ok = {
      tipo: 'vez_na_fila_merge',
      proximo_da_fila: true,
      semaforo_merge_livre: true,
    } as const;
    expect(para(proximoEstado(at('na_fila_merge'), ok))).toBe('integrando');
    expect(para(proximoEstado(at('na_fila_merge'), { ...ok, proximo_da_fila: false }))).toBe(
      'permanece',
    );
    expect(para(proximoEstado(at('na_fila_merge'), { ...ok, semaforo_merge_livre: false }))).toBe(
      'permanece',
    );
    expect(para(proximoEstado(at('na_fila_merge'), { ...ok, fila_travada: true }))).toBe(
      'permanece',
    );
  });

  it('integração: cada resultado vai ao destino da tabela', () => {
    const casos: [EventoMaquina & { tipo: 'integracao_concluida' }, string, TMotivo | null][] = [
      [{ tipo: 'integracao_concluida', resultado: 'mergeado' }, 'mergeado', null],
      [{ tipo: 'integracao_concluida', resultado: 'patch_id_mudou' }, 'aguardando_aprovacao', null],
      [
        { tipo: 'integracao_concluida', resultado: 'reverificacao_vermelha' },
        'implementando',
        null,
      ],
      [
        { tipo: 'integracao_concluida', resultado: 'reverificacao_falhou' },
        'falhou',
        'setup_falhou',
      ],
      [{ tipo: 'integracao_concluida', resultado: 'setup_falhou' }, 'falhou', 'setup_falhou'],
      [{ tipo: 'integracao_concluida', resultado: 'conflito' }, 'precisa_humano', 'conflito_merge'],
      [
        { tipo: 'integracao_concluida', resultado: 'conflito_schema' },
        'precisa_humano',
        'conflito_schema',
      ],
      [
        { tipo: 'integracao_concluida', resultado: 'schema_concorrente' },
        'precisa_humano',
        'schema_concorrente',
      ],
      [
        { tipo: 'integracao_concluida', resultado: 'push_recusado_3x' },
        'precisa_humano',
        'push_recusado',
      ],
      [
        { tipo: 'integracao_concluida', resultado: 'copia_suja_expirou' },
        'precisa_humano',
        'push_recusado',
      ],
      [{ tipo: 'integracao_concluida', resultado: 'recomecar' }, 'permanece', null],
      [
        { tipo: 'integracao_concluida', resultado: 'resolver_conflito' },
        'resolvendo_conflito',
        null,
      ],
    ];
    for (const [ev, destino, m] of casos) {
      const d = proximoEstado(at('integrando'), ev);
      expect([para(d), motivo(d)], ev.resultado).toEqual([destino, m]);
    }
  });

  it('resolução de conflito (FJ-036): resolvido → coleta; senão precisa_humano com o motivo', () => {
    const casos: [
      (EventoMaquina & { tipo: 'conflito_resolvido' })['resultado'],
      string,
      TMotivo | null,
    ][] = [
      ['resolvido', 'verificando', null],
      ['conflito_merge', 'precisa_humano', 'conflito_merge'],
      ['conflito_schema', 'precisa_humano', 'conflito_schema'],
      ['impedimento', 'precisa_humano', 'regra_conteudo_violada'],
    ];
    for (const [resultado, destino, m] of casos) {
      const d = proximoEstado(at('resolvendo_conflito'), { tipo: 'conflito_resolvido', resultado });
      expect([para(d), motivo(d)], resultado).toEqual([destino, m]);
    }
    // Só vale em `resolvendo_conflito`.
    expect(
      para(proximoEstado(at('integrando'), { tipo: 'conflito_resolvido', resultado: 'resolvido' })),
    ).toBe('recusado');
    // Turno de agente: estouro, cota, pausa e interrupção valem como nos outros.
    expect(
      motivo(
        proximoEstado(at('resolvendo_conflito'), { tipo: 'etapa_estourou', causa: 'timeout' }),
      ),
    ).toBe('timeout_etapa');
    expect(
      para(
        proximoEstado(at('resolvendo_conflito'), {
          tipo: 'limite_cota',
          overage_nao_autorizado: false,
        }),
      ),
    ).toBe('pausado_cota');
    expect(para(proximoEstado(at('resolvendo_conflito'), { tipo: 'processo_interrompido' }))).toBe(
      'interrompido',
    );
  });

  it('tentar de novo em conflito_merge → o agente resolve (FJ-036), nunca a fila nem Assumir', () => {
    const conflito: EstadoAtualExecucao = {
      estado: 'precisa_humano',
      estado_anterior: null,
      motivo_estado: 'conflito_merge',
    };
    const t = proximoEstado(conflito, { tipo: 'tentar_novamente', etapa_anterior: 'integrar' });
    expect(t.tipo === 'transicao' && [t.transicao.para, t.transicao.ator]).toEqual([
      'resolvendo_conflito',
      'humano',
    ]);
    // Parado no turno de conflito por outro motivo (timeout): volta ao turno.
    expect(
      para(
        proximoEstado(
          { estado: 'precisa_humano', estado_anterior: null, motivo_estado: 'timeout_etapa' },
          { tipo: 'tentar_novamente', etapa_anterior: 'resolver_conflito' },
        ),
      ),
    ).toBe('resolvendo_conflito');
    // Conflito em migration/schema segue o mapeamento por etapa (não resolve sozinho).
    expect(
      para(
        proximoEstado(
          { estado: 'precisa_humano', estado_anterior: null, motivo_estado: 'conflito_schema' },
          { tipo: 'tentar_novamente', etapa_anterior: 'integrar' },
        ),
      ),
    ).toBe('na_fila_merge');
  });

  it('outbox: mergeado → comunicando → (deploy | pendente | concluido)', () => {
    expect(para(proximoEstado(at('mergeado'), { tipo: 'outbox_iniciado' }))).toBe('comunicando');
    const ob = (resultado: 'concluido' | 'aguardar_deploy' | 'falha_retentavel' | 'em_andamento') =>
      para(proximoEstado(at('comunicando'), { tipo: 'outbox_avancou', resultado }));
    expect(ob('concluido')).toBe('concluido');
    expect(ob('aguardar_deploy')).toBe('aguardando_deploy');
    expect(ob('falha_retentavel')).toBe('mergeado_pendente_chamado');
    expect(ob('em_andamento')).toBe('permanece');
    expect(para(proximoEstado(at('mergeado_pendente_chamado'), { tipo: 'outbox_retentar' }))).toBe(
      'comunicando',
    );
  });

  it('interrupção e retomada automática 1×; a segunda vai a humano', () => {
    const i = proximoEstado(at('revisando'), { tipo: 'processo_interrompido' });
    expect(i.tipo === 'transicao' && i.transicao.estado_anterior).toBe('revisando');
    expect(para(proximoEstado(at('aguardando_plano'), { tipo: 'processo_interrompido' }))).toBe(
      'recusado',
    );
    expect(
      para(
        proximoEstado(at('interrompido', 'revisando'), {
          tipo: 'retomada_automatica',
          ja_retomada_nesta_etapa: false,
        }),
      ),
    ).toBe('revisando');
    const seg = proximoEstado(at('interrompido', 'revisando'), {
      tipo: 'retomada_automatica',
      ja_retomada_nesta_etapa: true,
    });
    expect([para(seg), motivo(seg)]).toEqual(['precisa_humano', 'segunda_interrupcao']);
  });

  it('cota: limite no meio → pausado_cota; liberação volta ao início da etapa', () => {
    const p = proximoEstado(at('implementando'), {
      tipo: 'limite_cota',
      overage_nao_autorizado: true,
    });
    expect([para(p), motivo(p)]).toEqual(['pausado_cota', 'cota_overage']);
    expect(
      motivo(
        proximoEstado(at('implementando'), { tipo: 'limite_cota', overage_nao_autorizado: false }),
      ),
    ).toBeNull();
    expect(
      para(
        proximoEstado(at('verificando'), { tipo: 'limite_cota', overage_nao_autorizado: false }),
      ),
    ).toBe('recusado');
    expect(
      para(proximoEstado(at('pausado_cota', 'implementando'), { tipo: 'cota_liberada' })),
    ).toBe('implementando');
  });

  it('falha de infraestrutura, estouro e regras persistentes', () => {
    expect(
      motivo(proximoEstado(at('planejando'), { tipo: 'falha_infra', motivo: 'saida_invalida' })),
    ).toBe('saida_invalida');
    expect(
      para(
        proximoEstado(at('aguardando_aprovacao'), { tipo: 'falha_infra', motivo: 'setup_falhou' }),
      ),
    ).toBe('recusado');
    expect(
      motivo(proximoEstado(at('implementando'), { tipo: 'etapa_estourou', causa: 'timeout' })),
    ).toBe('timeout_etapa');
    expect(
      motivo(proximoEstado(at('implementando'), { tipo: 'etapa_estourou', causa: 'teto_chamado' })),
    ).toBe('orcamento_etapa');
    expect(
      para(proximoEstado(at('aguardando_plano'), { tipo: 'etapa_estourou', causa: 'timeout' })),
    ).toBe('recusado');
    expect(
      motivo(proximoEstado(at('relatando'), { tipo: 'regra_conteudo_persistente', erros: ['x'] })),
    ).toBe('regra_conteudo_violada');
    expect(
      motivo(proximoEstado(at('verificando'), { tipo: 'sentinela_divergente', caminhos: ['a'] })),
    ).toBe('sentinela_divergente');
  });

  it('polling: chamado mudou antes do merge → humano; depois, permanece', () => {
    expect(
      motivo(proximoEstado(at('aguardando_aprovacao'), { tipo: 'chamado_mudou_no_servidor' })),
    ).toBe('chamado_mudou_no_servidor');
    expect(para(proximoEstado(at('comunicando'), { tipo: 'chamado_mudou_no_servidor' }))).toBe(
      'permanece',
    );
    expect(
      para(
        proximoEstado(at('assumido_manual', 'implementando'), {
          tipo: 'chamado_mudou_no_servidor',
        }),
      ),
    ).toBe('recusado');
  });

  it('IA do servidor ativa: humano antes de implementando; depois só alerta', () => {
    expect(motivo(proximoEstado(at('aguardando_plano'), { tipo: 'ia_servidor_ativa' }))).toBe(
      'ia_servidor_ativa',
    );
    expect(para(proximoEstado(at('revisando'), { tipo: 'ia_servidor_ativa' }))).toBe('permanece');
  });

  it('transição recusada pelo Chamados no Gdec → humano', () => {
    expect(motivo(proximoEstado(at('aguardando_decisao'), { tipo: 'transicao_recusada' }))).toBe(
      'transicao_recusada',
    );
    expect(para(proximoEstado(at('implementando'), { tipo: 'transicao_recusada' }))).toBe(
      'recusado',
    );
  });
});

describe('proximoEstado — ações humanas', () => {
  it('G1: aprovar → implementando; comentar → planejando', () => {
    expect(para(proximoEstado(at('aguardando_plano'), { tipo: 'aprovar_plano' }))).toBe(
      'implementando',
    );
    expect(para(proximoEstado(at('aguardando_plano'), { tipo: 'comentar_plano' }))).toBe(
      'planejando',
    );
    expect(para(proximoEstado(at('aguardando_decisao'), { tipo: 'aprovar_plano' }))).toBe(
      'recusado',
    );
  });

  it('Gdec: perguntar exige texto válido; decidir replaneja', () => {
    expect(
      para(
        proximoEstado(at('aguardando_decisao'), { tipo: 'perguntar_cliente', texto_valido: true }),
      ),
    ).toBe('aguardando_cliente_resposta');
    expect(
      para(
        proximoEstado(at('aguardando_decisao'), { tipo: 'perguntar_cliente', texto_valido: false }),
      ),
    ).toBe('recusado');
    expect(para(proximoEstado(at('aguardando_decisao'), { tipo: 'operador_decidiu' }))).toBe(
      'planejando',
    );
  });

  it('replanejar: cliente respondeu; em precisa_humano só sem commit', () => {
    expect(
      para(
        proximoEstado(at('aguardando_cliente_resposta'), {
          tipo: 'replanejar',
          cliente_respondeu: true,
        }),
      ),
    ).toBe('planejando');
    expect(
      para(
        proximoEstado(at('aguardando_cliente_resposta'), {
          tipo: 'replanejar',
          cliente_respondeu: false,
        }),
      ),
    ).toBe('recusado');
    expect(
      para(proximoEstado(at('precisa_humano'), { tipo: 'replanejar', existe_commit: false })),
    ).toBe('planejando');
    expect(
      para(proximoEstado(at('precisa_humano'), { tipo: 'replanejar', existe_commit: true })),
    ).toBe('recusado');
    expect(para(proximoEstado(at('implementando'), { tipo: 'replanejar' }))).toBe('recusado');
  });

  it('G2: aprovar exige exigências ok; pedir ajustes exige comentário', () => {
    expect(
      para(
        proximoEstado(at('aguardando_aprovacao'), { tipo: 'aprovar_final', exigencias_ok: true }),
      ),
    ).toBe('na_fila_merge');
    expect(
      para(
        proximoEstado(at('aguardando_aprovacao'), { tipo: 'aprovar_final', exigencias_ok: false }),
      ),
    ).toBe('recusado');
    expect(
      para(proximoEstado(at('aguardando_aprovacao'), { tipo: 'pedir_ajustes', comentario: 'x' })),
    ).toBe('retrabalho_humano');
    expect(
      para(proximoEstado(at('aguardando_aprovacao'), { tipo: 'pedir_ajustes', comentario: '  ' })),
    ).toBe('recusado');
  });

  it('Assumir/Devolver: PTY fechado; Devolver vai a verificando', () => {
    const a = proximoEstado(at('aguardando_aprovacao'), { tipo: 'assumir' });
    expect(a.tipo === 'transicao' && a.transicao.estado_anterior).toBe('aguardando_aprovacao');
    expect(para(proximoEstado(at('na_fila'), { tipo: 'assumir' }))).toBe('recusado');
    expect(
      para(
        proximoEstado(at('assumido_manual', 'implementando'), {
          tipo: 'devolver',
          pty_fechado: true,
        }),
      ),
    ).toBe('verificando');
    expect(
      para(
        proximoEstado(at('assumido_manual', 'implementando'), {
          tipo: 'devolver',
          pty_fechado: false,
        }),
      ),
    ).toBe('recusado');
  });

  it('pausar/retomar; retomar pausado_cota só com créditos extras autorizados', () => {
    expect(para(proximoEstado(at('relatando'), { tipo: 'pausar' }))).toBe('pausado_usuario');
    expect(para(proximoEstado(at('aguardando_plano'), { tipo: 'pausar' }))).toBe('recusado');
    expect(para(proximoEstado(at('pausado_usuario', 'relatando'), { tipo: 'retomar' }))).toBe(
      'relatando',
    );
    expect(para(proximoEstado(at('pausado_cota', 'relatando'), { tipo: 'retomar' }))).toBe(
      'recusado',
    );
    expect(
      para(
        proximoEstado(at('pausado_cota', 'relatando'), {
          tipo: 'retomar',
          creditos_extras_autorizados: true,
        }),
      ),
    ).toBe('relatando');
    expect(para(proximoEstado(at('implementando'), { tipo: 'retomar' }))).toBe('recusado');
  });

  it('tentar de novo: falhou/interrompido voltam; pendente de chamado volta a comunicar', () => {
    expect(para(proximoEstado(at('falhou', 'verificando'), { tipo: 'tentar_novamente' }))).toBe(
      'verificando',
    );
    expect(
      para(proximoEstado(at('interrompido', 'planejando'), { tipo: 'tentar_novamente' })),
    ).toBe('planejando');
    const t = proximoEstado(at('mergeado_pendente_chamado'), { tipo: 'tentar_novamente' });
    expect(t.tipo === 'transicao' && [t.transicao.para, t.transicao.ator]).toEqual([
      'comunicando',
      'humano',
    ]);
    expect(para(proximoEstado(at('revisando'), { tipo: 'tentar_novamente' }))).toBe('recusado');
  });

  it('precisa_humano: mais um ciclo (com confirmação acima do teto), seguir, editar, re-merge', () => {
    expect(
      para(
        proximoEstado(at('precisa_humano'), {
          tipo: 'mais_um_ciclo',
          exige_confirmacao: false,
          confirmado: false,
        }),
      ),
    ).toBe('implementando');
    expect(
      para(
        proximoEstado(at('precisa_humano'), {
          tipo: 'mais_um_ciclo',
          exige_confirmacao: true,
          confirmado: false,
        }),
      ),
    ).toBe('recusado');
    expect(
      para(
        proximoEstado(at('precisa_humano'), {
          tipo: 'mais_um_ciclo',
          exige_confirmacao: true,
          confirmado: true,
        }),
      ),
    ).toBe('implementando');
    expect(para(proximoEstado(at('precisa_humano'), { tipo: 'seguir_com_achados' }))).toBe(
      'relatando',
    );
    expect(
      para(
        proximoEstado(at('precisa_humano', null, 'relatorio_incoerente'), {
          tipo: 'editar_relatorio',
        }),
      ),
    ).toBe('aguardando_aprovacao');
    expect(
      para(
        proximoEstado(at('precisa_humano', null, 'pingue_pongue'), { tipo: 'editar_relatorio' }),
      ),
    ).toBe('recusado');
    expect(
      para(
        proximoEstado(at('precisa_humano', null, 'push_recusado'), {
          tipo: 'tentar_merge_de_novo',
          aprovacao_vigente: true,
        }),
      ),
    ).toBe('na_fila_merge');
    expect(
      para(
        proximoEstado(at('precisa_humano', null, 'push_recusado'), {
          tipo: 'tentar_merge_de_novo',
          aprovacao_vigente: false,
        }),
      ),
    ).toBe('recusado');
    expect(
      para(
        proximoEstado(at('precisa_humano', null, 'conflito_merge'), {
          tipo: 'tentar_merge_de_novo',
          aprovacao_vigente: true,
        }),
      ),
    ).toBe('recusado');
  });

  it('encerrar preserva chamado_mudou_no_servidor; descartar antes do merge', () => {
    expect(motivo(proximoEstado(at('na_fila'), { tipo: 'encerrar' }))).toBe('humano_encerrou');
    expect(
      motivo(
        proximoEstado(at('precisa_humano', null, 'chamado_mudou_no_servidor'), {
          tipo: 'encerrar',
        }),
      ),
    ).toBe('chamado_mudou_no_servidor');
    expect(para(proximoEstado(at('revisando'), { tipo: 'descartar' }))).toBe('descartado');
    expect(para(proximoEstado(at('mergeado'), { tipo: 'descartar' }))).toBe('recusado');
    expect(para(proximoEstado(at('concluido'), { tipo: 'descartar' }))).toBe('recusado');
  });

  it('Gdeploy: publicado em produção só de aguardando_deploy', () => {
    expect(para(proximoEstado(at('aguardando_deploy'), { tipo: 'publicado_producao' }))).toBe(
      'comunicando',
    );
    expect(para(proximoEstado(at('comunicando'), { tipo: 'publicado_producao' }))).toBe('recusado');
  });
});
