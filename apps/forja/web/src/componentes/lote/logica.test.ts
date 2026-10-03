import { describe, expect, it } from 'vitest';
import type { CartaoPlanoDto, ChamadoResumoDto, LinhaLoteDto } from '@comum/dto';
import type { PlanoRegistrado } from '@comum/contratos';
import type { EstadoExecucao } from '@comum/estados';
import {
  aindaNaoImplementou,
  classeEfetiva,
  contarFiltros,
  filtrarEOrdenar,
  limposSelecionaveis,
  naMesaDePlanos,
  pendentesCancelaveis,
  planoLimpo,
  reconciliarSelecao,
  resumoGrupos,
  resumoLinhaPlano,
} from './logica';

function plano(p: Partial<PlanoRegistrado> = {}): PlanoRegistrado {
  return {
    natureza_confirmada: 'alteracao',
    confianca: 'alta',
    perguntas_ao_cliente: [],
    decisoes_do_operador: [],
    schema_banco: { altera: false, mudancas: [] },
    alertas_seguranca: [],
    passos: [{ id: 'P1', descricao: 'x', arquivos_previstos: ['a.ts'], depende_de: [] }],
    arquivos_previstos: ['a.ts', 'b.ts'],
    ...p,
  } as unknown as PlanoRegistrado;
}

function chamado(numero: number): ChamadoResumoDto {
  return {
    chamado_id: `c${numero}`,
    numero,
    titulo: `Chamado ${numero}`,
    status: 'em_atendimento',
    natureza: 'alteracao',
    prioridade: 'media',
    complexidade: null,
    sistema_nome: 'ERP',
    atualizado_em_remoto: null,
  };
}

function cartao(
  numero: number,
  classe: CartaoPlanoDto['classe'],
  estado: EstadoExecucao = 'aguardando_plano',
  p: PlanoRegistrado | null = plano(),
): CartaoPlanoDto {
  return {
    execucao_id: `e${numero}`,
    chamado: chamado(numero),
    estado,
    classe,
    plano: p,
    resumo_linha: null,
    planejando_desde: null,
    erro: null,
    posicao_schema: null,
  };
}

describe('planoLimpo (06 §4.4)', () => {
  it('limpo só com confiança alta e sem pergunta, schema, alerta ou decisão', () => {
    expect(planoLimpo(plano())).toBe(true);
    expect(planoLimpo(plano({ confianca: 'media' }))).toBe(false);
    expect(
      planoLimpo(
        plano({
          perguntas_ao_cliente: [{ pergunta: 'a', por_que_importa: 'b', suposicao_padrao: 'c' }],
        }),
      ),
    ).toBe(false);
    expect(planoLimpo(plano({ schema_banco: { altera: true, mudancas: [] } }))).toBe(false);
    expect(planoLimpo(plano({ alertas_seguranca: ['ler ~/.ssh'] }))).toBe(false);
    expect(
      planoLimpo(
        plano({ decisoes_do_operador: [{ questao: 'q', opcoes: ['a', 'b'], recomendacao: 'a' }] }),
      ),
    ).toBe(false);
    expect(planoLimpo(plano({ natureza_confirmada: 'nao_implementavel' }))).toBe(false);
  });

  it('servidor diz "limpo" mas a regra local discorda → precisa de revisão', () => {
    const c = cartao(1, 'limpo', 'aguardando_plano', plano({ confianca: 'baixa' }));
    expect(classeEfetiva(c)).toBe('precisa_revisao');
    expect(limposSelecionaveis([c])).toEqual([]);
  });
});

describe('filtros e ordem da mesa', () => {
  const cartoes = [
    cartao(140, 'planejando', 'planejando', null),
    cartao(128, 'limpo'),
    cartao(141, 'alerta_seguranca'),
    cartao(133, 'decisao', 'aguardando_decisao'),
    cartao(137, 'schema'),
    cartao(150, 'limpo', 'implementando'),
  ];

  it('conta por filtro (todos/limpos/precisam/planejando)', () => {
    expect(contarFiltros(cartoes)).toEqual({ todos: 6, limpos: 2, precisam: 3, planejando: 1 });
  });

  it('ordena: pendentes antes dos já decididos; alerta > decisão > schema > limpo > planejando', () => {
    expect(filtrarEOrdenar(cartoes, 'todos').map((c) => c.chamado.numero)).toEqual([
      141, 133, 137, 128, 140, 150,
    ]);
    expect(filtrarEOrdenar(cartoes, 'limpos').map((c) => c.chamado.numero)).toEqual([128, 150]);
  });

  it('só limpos aguardando G1 são selecionáveis', () => {
    expect(limposSelecionaveis(cartoes).map((c) => c.execucao_id)).toEqual(['e128']);
  });

  it('reconcilia a seleção: novos limpos entram marcados, desmarcados pelo usuário ficam fora', () => {
    const primeira = reconciliarSelecao(new Set(), new Set(), cartoes);
    expect([...primeira]).toEqual(['e128']);
    // O usuário desmarcou o #128; ele já é conhecido e não volta sozinho.
    const depois = reconciliarSelecao(new Set(), new Set(['e128']), [
      ...cartoes,
      cartao(160, 'limpo'),
    ]);
    expect([...depois]).toEqual(['e160']);
    // Cartão que deixou de ser selecionável sai da seleção.
    const sai = reconciliarSelecao(new Set(['e128']), new Set(['e128']), [
      cartao(128, 'limpo', 'implementando'),
    ]);
    expect([...sai]).toEqual([]);
  });

  it('resumo de uma linha cai para passos/arquivos/confiança', () => {
    expect(resumoLinhaPlano(cartao(1, 'limpo'))).toBe('1 passo · 2 arquivos · confiança alta');
    expect(resumoLinhaPlano({ ...cartao(1, 'limpo'), resumo_linha: 'Corrige o desconto' })).toBe(
      'Corrige o desconto',
    );
  });
});

describe('lote', () => {
  it('"cancelar pendentes" só pega o que não começou a implementar (laterais pelo anterior)', () => {
    expect(aindaNaoImplementou('planejando', null)).toBe(true);
    expect(aindaNaoImplementou('aguardando_decisao', null)).toBe(true);
    expect(aindaNaoImplementou('implementando', null)).toBe(false);
    expect(aindaNaoImplementou('pausado_cota', 'planejando')).toBe(true);
    expect(aindaNaoImplementou('pausado_cota', 'implementando')).toBe(false);
    expect(aindaNaoImplementou('concluido', null)).toBe(false);

    const linha = (estado: EstadoExecucao): LinhaLoteDto =>
      ({
        chamado: chamado(1),
        execucao: { estado, estado_anterior: null },
        mini_trilha: [],
        observacao: null,
        acao: null,
      }) as unknown as LinhaLoteDto;
    expect(
      pendentesCancelaveis([linha('na_fila'), linha('revisando'), linha('aguardando_plano')]).map(
        (l) => l.execucao.estado,
      ),
    ).toEqual(['na_fila', 'aguardando_plano']);
    // FJ-034: a mesa só aparece se algum plano parou (G1 ou Gdec).
    expect(naMesaDePlanos([linha('implementando'), linha('aguardando_aprovacao')])).toBe(0);
    expect(naMesaDePlanos([linha('aguardando_plano'), linha('aguardando_decisao')])).toBe(2);
  });

  it('resumo por grupo na ordem de urgência, sem zeros', () => {
    expect(
      resumoGrupos({ trabalhando: 3, aguardando_voce: 2, concluido: 0 }).map((g) => g.texto),
    ).toEqual(['2 aguardando você', '3 trabalhando']);
  });
});
