import { describe, expect, it } from 'vitest';
import { planoFalso } from './apoio-testes';
import {
  arquivosEmComum,
  chaveDestino,
  decidirSchemaImprevisto,
  distribuirVagas,
  faseDoLote,
  liberar,
  liberarTudoMenosSchema,
  lotePendencias,
  montarMesa,
  ocupar,
  ordenarInicio,
  planoLimpo,
  podeIniciar,
  proximoDaFilaMerge,
  recursosDaEtapa,
  semaforosVazios,
  soltaTokenSchema,
  validarAprovacaoEmBloco,
  type CandidatoVaga,
  type ItemFila,
} from './lote';

/** Lote, mesa, semáforos e token schema (specs/forja/03 §7; 06 §4.4/§4.5). */

const SCHEMA = {
  altera: true,
  mudancas: [{ tipo: 'coluna_nova' as const, objeto: 't.c', descricao: 'd', reversivel: true }],
};
const K = chaveDestino('p1', 'main');

describe('plano limpo e mesa de planos (03 §7.4)', () => {
  it('limpo = alta, sem perguntas/decisões, sem schema, sem alertas', () => {
    expect(planoLimpo(planoFalso())).toEqual({ limpo: true, motivos: [] });
    const sujo = planoLimpo(
      planoFalso({
        confianca: 'media',
        schema_banco: SCHEMA,
        alertas_seguranca: ['x'],
        decisoes_do_operador: [{ questao: 'q', opcoes: ['a', 'b'], recomendacao: 'a' }],
        perguntas_ao_cliente: [{ pergunta: 'p', por_que_importa: 'x', suposicao_padrao: 'y' }],
      }),
    );
    expect(sujo.motivos).toEqual([
      'confianca_nao_alta',
      'perguntas_ao_cliente',
      'decisoes_do_operador',
      'altera_schema',
      'alertas_seguranca',
    ]);
  });

  const itens = [
    { execucao_id: 'a', estado: 'aguardando_plano' as const, plano: planoFalso() },
    {
      execucao_id: 'b',
      estado: 'aguardando_plano' as const,
      plano: planoFalso({ schema_banco: SCHEMA }),
    },
    { execucao_id: 'c', estado: 'aguardando_decisao' as const, plano: planoFalso() },
    { execucao_id: 'd', estado: 'planejando' as const, plano: null },
    { execucao_id: 'e', estado: 'implementando' as const, plano: planoFalso() },
  ];

  it('agrupa a mesa', () => {
    expect(montarMesa(itens)).toEqual({
      limpos: ['a'],
      individuais: ['b'],
      decisao: ['c'],
      planejando: ['d'],
      outros: ['e'],
    });
  });

  it('aprovação em bloco só de limpos em aguardando_plano do lote', () => {
    expect(validarAprovacaoEmBloco(['a'], itens)).toEqual({ ok: true, erros: [] });
    expect(validarAprovacaoEmBloco([], itens).ok).toBe(false);
    const r = validarAprovacaoEmBloco(['a', 'b', 'c', 'z', 'a'], itens);
    expect(r.ok).toBe(false);
    expect(r.erros.map((e) => e.execucao_id)).toEqual(['b', 'c', 'z', 'a']);
  });

  it('arquivos em comum (aviso)', () => {
    expect(
      arquivosEmComum([
        { execucao_id: 'a', arquivos_previstos: ['x.ts', 'y.ts'] },
        { execucao_id: 'b', arquivos_previstos: ['y.ts'] },
      ]),
    ).toEqual([{ arquivo: 'y.ts', execucoes: ['a', 'b'] }]);
  });
});

describe('ordem de início (03 §7.2)', () => {
  const itens = [
    {
      execucao_id: 'velho_baixa',
      prioridade: 'baixa' as const,
      complexidade: 'facil' as const,
      chamado_criado_em: '2026-01-01T00:00:00Z',
    },
    {
      execucao_id: 'urg_dificil',
      prioridade: 'urgente' as const,
      complexidade: 'dificil' as const,
      chamado_criado_em: '2026-09-01T00:00:00Z',
    },
    {
      execucao_id: 'urg_facil',
      prioridade: 'urgente' as const,
      complexidade: 'facil' as const,
      chamado_criado_em: '2026-09-02T00:00:00Z',
    },
    {
      execucao_id: 'urg_facil_velho',
      prioridade: 'urgente' as const,
      complexidade: 'facil' as const,
      chamado_criado_em: '2026-08-01T00:00:00Z',
    },
    {
      execucao_id: 'urg_sem',
      prioridade: 'urgente' as const,
      complexidade: null,
      chamado_criado_em: '2026-01-01T00:00:00Z',
    },
  ];

  it('prioridade, complexidade (sem classificação por último), idade', () => {
    expect(ordenarInicio(itens)).toEqual([
      'urg_facil_velho',
      'urg_facil',
      'urg_dificil',
      'urg_sem',
      'velho_baixa',
    ]);
  });

  it('a ordem manual do humano vale para os ids que cita', () => {
    expect(ordenarInicio(itens, ['velho_baixa', 'urg_sem'])).toEqual([
      'velho_baixa',
      'urg_sem',
      'urg_facil_velho',
      'urg_facil',
      'urg_dificil',
    ]);
  });
});

describe('semáforos puros (03 §7.2, §7.3)', () => {
  it('podeIniciar/ocupar/liberar respeitam o limite e são idempotentes', () => {
    let s = semaforosVazios();
    expect(s.agentes.limite).toBe(2);
    s = ocupar(s, { execucao_id: 'a', recurso: 'agentes' });
    s = ocupar(s, { execucao_id: 'b', recurso: 'agentes' });
    expect(podeIniciar(s, { execucao_id: 'a', recurso: 'agentes' })).toEqual({
      ok: true,
      ja_ocupa: true,
    });
    expect(ocupar(s, { execucao_id: 'a', recurso: 'agentes' })).toBe(s);
    expect(podeIniciar(s, { execucao_id: 'c', recurso: 'agentes' })).toMatchObject({
      ok: false,
      ocupantes: ['a', 'b'],
    });
    expect(() => ocupar(s, { execucao_id: 'c', recurso: 'agentes' })).toThrow();
    s = liberar(s, { execucao_id: 'a', recurso: 'agentes' });
    expect(podeIniciar(s, { execucao_id: 'c', recurso: 'agentes' }).ok).toBe(true);
    expect(liberar(s, { execucao_id: 'zz', recurso: 'agentes' })).toBe(s);
  });

  it('merge e schema são por (projeto, destino)', () => {
    let s = semaforosVazios();
    s = ocupar(s, { execucao_id: 'a', recurso: 'merge', chave: K });
    expect(podeIniciar(s, { execucao_id: 'b', recurso: 'merge', chave: K }).ok).toBe(false);
    expect(
      podeIniciar(s, { execucao_id: 'b', recurso: 'merge', chave: chaveDestino('p1', 'dev') }).ok,
    ).toBe(true);
    expect(() => podeIniciar(s, { execucao_id: 'b', recurso: 'schema' })).toThrow(/chave/);
    s = liberar(s, { execucao_id: 'a', recurso: 'merge', chave: K });
    expect(s.merge.ocupantes).toEqual({});
  });

  it('liberar tudo menos o schema (precisa_humano segura o token)', () => {
    let s = semaforosVazios();
    s = ocupar(s, { execucao_id: 'a', recurso: 'agentes' });
    s = ocupar(s, { execucao_id: 'a', recurso: 'schema', chave: K });
    s = ocupar(s, { execucao_id: 'a', recurso: 'merge', chave: K });
    s = liberarTudoMenosSchema(s, 'a');
    expect(s.agentes.ocupantes).toEqual([]);
    expect(s.merge.ocupantes).toEqual({});
    expect(s.schema.ocupantes[K]).toEqual(['a']);
  });

  it('recursos por etapa: turno de agente, coleta sem vaga (FJ-032), merge do destino, conversa sem vaga', () => {
    expect(recursosDaEtapa('planejar', { chave_destino: K })).toEqual([
      { recurso: 'planejadores' },
    ]);
    expect(
      recursosDaEtapa('implementar', { chave_destino: K, precisa_token_schema: true }),
    ).toEqual([{ recurso: 'agentes' }, { recurso: 'schema', chave: K }]);
    expect(recursosDaEtapa('evidenciar', { chave_destino: K })).toEqual([]);
    expect(recursosDaEtapa('verificar', { chave_destino: K })).toEqual([]);
    expect(recursosDaEtapa('integrar', { chave_destino: K })).toEqual([
      { recurso: 'merge', chave: K },
    ]);
    expect(recursosDaEtapa('conversar', { chave_destino: K })).toEqual([]);
  });

  it('token schema solta só em mergeado/descartado/cancelado', () => {
    expect(soltaTokenSchema('mergeado')).toBe(true);
    expect(soltaTokenSchema('descartado')).toBe(true);
    expect(soltaTokenSchema('cancelado')).toBe(true);
    expect(soltaTokenSchema('precisa_humano')).toBe(false);
  });

  it('schema imprevisto: toma se livre; senão alerta "schema concorrente com #N"', () => {
    const livre = decidirSchemaImprevisto(semaforosVazios(), 'a', K);
    expect(livre.acao).toBe('tomar');
    if (livre.acao !== 'tomar') throw new Error();
    expect(decidirSchemaImprevisto(livre.semaforos, 'a', K)).toEqual({ acao: 'ja_tem' });
    expect(decidirSchemaImprevisto(livre.semaforos, 'b', K)).toEqual({
      acao: 'alertar',
      ocupantes: ['a'],
      alerta: 'schema concorrente com a',
    });
  });
});

describe('distribuirVagas (03 §7.2; critério 03 §12.5)', () => {
  const c = (p: Partial<CandidatoVaga> & { execucao_id: string }): CandidatoVaga => ({
    estado: 'na_fila',
    etapa: 'implementar',
    ordem: 0,
    chave_destino: K,
    ...p,
  });

  it('vaga vai primeiro para quem está mais adiante, depois a ordem do lote', () => {
    const r = distribuirVagas({
      candidatos: [
        c({ execucao_id: 'nova', estado: 'implementando', ordem: 0 }),
        c({ execucao_id: 'rel', estado: 'relatando', etapa: 'relatar', ordem: 9 }),
        c({ execucao_id: 'rev', estado: 'revisando', etapa: 'revisar', ordem: 8 }),
      ],
      semaforos: semaforosVazios(),
      freio_ativo: false,
      cli_compativel: true,
    });
    expect(r.iniciar.map((i) => i.execucao_id)).toEqual(['rel', 'rev']);
    expect(r.aguardando).toMatchObject([
      { execucao_id: 'nova', razao: 'aguardando vaga (agentes)' },
    ]);
    expect(r.semaforos.agentes.ocupantes).toEqual(['rel', 'rev']);
  });

  it('lote de 3 com 2 de schema: o segundo de schema espera', () => {
    const r = distribuirVagas({
      candidatos: [
        c({ execucao_id: 's1', precisa_token_schema: true, ordem: 0 }),
        c({ execucao_id: 's2', precisa_token_schema: true, ordem: 1 }),
        c({ execucao_id: 'x', ordem: 2 }),
      ],
      semaforos: semaforosVazios(),
      freio_ativo: false,
      cli_compativel: true,
    });
    expect(r.iniciar.map((i) => i.execucao_id)).toEqual(['s1', 'x']);
    expect(r.aguardando).toEqual([
      { execucao_id: 's2', razao: 'aguardando vaga de schema', ocupantes: ['s1'] },
    ]);
  });

  it('freio e CLI seguram só etapas de agente; verificação segue', () => {
    const r = distribuirVagas({
      candidatos: [
        c({ execucao_id: 'impl', ordem: 0 }),
        c({ execucao_id: 'ver', estado: 'verificando', etapa: 'verificar', ordem: 1 }),
      ],
      semaforos: semaforosVazios(),
      freio_ativo: true,
      cli_compativel: true,
    });
    expect(r.iniciar.map((i) => i.execucao_id)).toEqual(['ver']);
    expect(r.aguardando).toEqual([{ execucao_id: 'impl', razao: 'freio de cota' }]);
    const cli = distribuirVagas({
      candidatos: [c({ execucao_id: 'impl' })],
      semaforos: semaforosVazios(),
      freio_ativo: false,
      cli_compativel: false,
    });
    expect(cli.aguardando).toEqual([{ execucao_id: 'impl', razao: 'CLI incompatível' }]);
  });
});

describe('fila de merge e falha parcial (03 §7.5, §8; I-5)', () => {
  const item = (p: Partial<ItemFila> & { id: string }): ItemFila => ({
    execucao_id: p.id,
    ordem: 0,
    estado: 'aguardando',
    ...p,
  });

  it('próximo pela ordem; nenhum se há item em processamento ou fila travada', () => {
    const itens = [item({ id: 'b', ordem: 2 }), item({ id: 'a', ordem: 1 })];
    expect(proximoDaFilaMerge(itens, { mergeadas: new Set() })?.id).toBe('a');
    expect(
      proximoDaFilaMerge([...itens, item({ id: 'c', estado: 'integrando' })], {
        mergeadas: new Set(),
      }),
    ).toBeNull();
    expect(proximoDaFilaMerge(itens, { mergeadas: new Set(), travada: true })).toBeNull();
  });

  it('schema concorrente só integra depois do dono do token mergear', () => {
    const itens = [
      item({ id: 'a', ordem: 1, depois_de_execucao_id: 'n' }),
      item({ id: 'b', ordem: 2 }),
    ];
    expect(proximoDaFilaMerge(itens, { mergeadas: new Set() })?.id).toBe('b');
    expect(proximoDaFilaMerge(itens, { mergeadas: new Set(['n']) })?.id).toBe('a');
  });

  it('fase do lote é derivada e monotônica', () => {
    expect(faseDoLote('planejando', ['planejando', 'na_fila'])).toBe('planejando');
    expect(faseDoLote('planejando', ['planejando', 'aguardando_plano'])).toBe('mesa_de_planos');
    expect(faseDoLote('mesa_de_planos', ['implementando', 'aguardando_plano'])).toBe(
      'implementando',
    );
    expect(faseDoLote('implementando', ['aguardando_plano'])).toBe('implementando');
    expect(faseDoLote('implementando', ['concluido', 'descartado'])).toBe('encerrado');
    expect(faseDoLote('cancelado', ['implementando'])).toBe('cancelado');
    expect(faseDoLote('planejando', ['precisa_humano'])).toBe('planejando');
  });

  it('pendências: precisa_humano/falhou não param as outras, só sinalizam', () => {
    expect(lotePendencias(['implementando', 'precisa_humano'])).toBe(true);
    expect(lotePendencias(['implementando', 'descartado'])).toBe(false);
  });
});
