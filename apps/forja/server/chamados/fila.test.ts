import { describe, expect, it } from 'vitest';
import {
  avaliarG0,
  consultarFila,
  detectarD036,
  filtrarComplexidade,
  resolverProjeto,
  type EntradaG0,
  type MapeamentoSistema,
} from './fila';
import { ChamadosFalso, detalheFalso, itemFalso } from './servidor-falso.test-apoio';

/** Fila e pré-condições do G0 (specs/forja/07 §3; 03 §4.1) com `fetch` falso. */

describe('consultarFila', () => {
  function servidor(d036: boolean) {
    const s = new ChamadosFalso();
    s.d036 = d036;
    s.lista = [
      itemFalso({ numero: 1, natureza: 'alteracao', complexidade: 'facil', ia_silenciada: true }),
      itemFalso({ numero: 2, natureza: 'problema', complexidade: 'dificil', ia_silenciada: false }),
      itemFalso({
        numero: 3,
        natureza: 'problema',
        complexidade: null,
        status: 'aguardando_cliente',
      }),
      itemFalso({ numero: 4, natureza: 'duvida', complexidade: 'facil' }),
      itemFalso({ numero: 5, natureza: 'alteracao', status: 'em_triagem' }),
      ...Array.from({ length: 150 }, (_, i) =>
        itemFalso({ numero: 100 + i, natureza: 'alteracao', complexidade: 'medio' }),
      ),
    ];
    return s;
  }

  it('duas chamadas por natureza, status do implementável, paginando até o fim', async () => {
    const s = servidor(true);
    const r = await consultarFila(s.cliente());
    const listagens = s.requisicoes.filter((q) => q.caminho === '/api/v1/chamados');
    const naturezas = new Set(listagens.map((q) => q.query.get('natureza')));
    expect(naturezas).toEqual(new Set(['alteracao', 'problema']));
    for (const q of listagens) {
      expect(q.query.get('status')).toBe('em_atendimento,aguardando_cliente');
      expect(q.query.get('limite')).toBe('100');
    }
    expect(listagens.length).toBe(3); // alteracao pagina 2×
    const numeros = r.itens.map((i) => i.numero);
    expect(numeros).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(numeros).not.toContain(4);
    expect(numeros).not.toContain(5);
    expect(r.itens).toHaveLength(153);
    expect(r.d036).toBe(true);
  });

  it('sem D-036: não manda ?complexidade= (seria ignorado) e filtra em memória', async () => {
    const s = servidor(false);
    const r = await consultarFila(s.cliente(), {
      complexidades: ['facil', 'dificil'],
      d036: false,
    });
    expect(s.requisicoes.every((q) => !q.query.has('complexidade'))).toBe(true);
    expect(r.itens.map((i) => i.numero).sort()).toEqual([1, 2]);
    expect(r.d036).toBe(false);
  });

  it('com D-036: manda ?complexidade= e ainda filtra em memória', async () => {
    const s = servidor(true);
    const r = await consultarFila(s.cliente(), { complexidades: ['facil'], d036: true });
    const q = s.requisicoes.find((x) => x.caminho === '/api/v1/chamados')!;
    expect(q.query.get('complexidade')).toBe('facil');
    expect(r.itens.map((i) => i.numero)).toEqual([1]);
  });

  it('detectarD036 e filtrarComplexidade (null fica fora com filtro)', () => {
    expect(detectarD036([])).toBeNull();
    expect(detectarD036([itemFalso({ numero: 1 })])).toBe(false);
    expect(detectarD036([itemFalso({ numero: 1, ia_silenciada: false })])).toBe(true);
    const itens = [
      itemFalso({ numero: 1, complexidade: null }),
      itemFalso({ numero: 2, complexidade: 'medio' }),
    ];
    expect(filtrarComplexidade(itens, [])).toHaveLength(2);
    expect(filtrarComplexidade(itens, ['medio']).map((i) => i.numero)).toEqual([2]);
  });
});

describe('resolverProjeto', () => {
  const maps: MapeamentoSistema[] = [
    { id: 'm1', projeto_id: 'p-erp', sistema_alvo_id: null, sistema_nome: 'ERP' },
    { id: 'm2', projeto_id: 'p-site', sistema_alvo_id: 's-site', sistema_nome: 'Site' },
  ];

  it('por id quando a API traz (L2)', () => {
    expect(
      resolverProjeto({ sistema_alvo_id: 's-site', sistema_nome: 'Site novo' }, maps),
    ).toMatchObject({
      projeto_id: 'p-site',
      via: 'id',
    });
  });

  it('por nome como fallback, devolvendo a conversão para id', () => {
    expect(resolverProjeto({ sistema_alvo_id: 's-erp', sistema_nome: '  erp ' }, maps)).toEqual({
      projeto_id: 'p-erp',
      mapeamento_id: 'm1',
      via: 'nome',
      converter_para_id: 's-erp',
    });
    expect(resolverProjeto({ sistema_nome: 'ERP' }, maps)).toMatchObject({
      via: 'nome',
      converter_para_id: null,
    });
  });

  it('mapeamento que já guarda OUTRO id não casa por nome; sem sistema/sem mapeamento', () => {
    expect(
      resolverProjeto({ sistema_alvo_id: 's-outro', sistema_nome: 'Site' }, maps),
    ).toMatchObject({
      projeto_id: null,
      motivo: 'sem_mapeamento',
    });
    expect(resolverProjeto({ sistema_alvo_id: null, sistema_nome: null }, maps)).toMatchObject({
      motivo: 'sem_sistema',
    });
  });
});

describe('avaliarG0 — pré-condições', () => {
  const base: EntradaG0 = {
    chamado: { status: 'em_atendimento', natureza: 'alteracao' },
    projeto: { projeto_id: 'p', mapeamento_id: 'm', via: 'nome', converter_para_id: null },
    execucaoAtiva: false,
    conexaoOk: true,
  };
  const falha = (e: EntradaG0) =>
    avaliarG0(e)
      .pre_condicoes.filter((p) => !p.ok)
      .map((p) => p.codigo);

  it('caso normal: implementável', () => {
    const r = avaliarG0(base);
    expect(r.implementavel).toBe(true);
    expect(r.exige_confirmacao).toBe(false);
    expect(r.forca_g1).toBe(false);
  });

  it('status: novo/em_triagem/terminais recusados; aguardando_cliente com confirmação', () => {
    for (const status of ['novo', 'em_triagem', 'resolvido', 'fechado', 'cancelado'] as const) {
      expect(falha({ ...base, chamado: { ...base.chamado, status } })).toEqual(['status']);
    }
    const r = avaliarG0({ ...base, chamado: { ...base.chamado, status: 'aguardando_cliente' } });
    expect(r.implementavel).toBe(true);
    expect(r.exige_confirmacao).toBe(true);
  });

  it('natureza duvida não é implementável', () => {
    expect(falha({ ...base, chamado: { ...base.chamado, natureza: 'duvida' } })).toEqual([
      'natureza',
    ]);
  });

  it('FJ-031: a IA do servidor não é pré-condição (nem bloqueio, nem confirmação)', () => {
    const r = avaliarG0(base);
    expect(r.pre_condicoes.map((p) => p.codigo)).toEqual([
      'status',
      'natureza',
      'sistema_mapeado',
      'sem_execucao_ativa',
      'conexao_ok',
      'pipeline_desbloqueado',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/silenciad/i);
    expect(r).toMatchObject({ implementavel: true, exige_confirmacao: false });
  });

  it('sem projeto, execução ativa, conexão e pipeline', () => {
    expect(
      falha({
        ...base,
        projeto: { projeto_id: null, mapeamento_id: null, via: null, motivo: 'sem_mapeamento' },
        execucaoAtiva: true,
        conexaoOk: false,
        pipelineDesbloqueado: false,
      }),
    ).toEqual(['sistema_mapeado', 'sem_execucao_ativa', 'conexao_ok', 'pipeline_desbloqueado']);
  });

  it('PR ia/chamado-N-* detectado não bloqueia: vira trabalho_existente e força G1', () => {
    const prIa = { branch: 'ia/chamado-12-frete', numero_na_branch: 12, pr_url: null };
    const r = avaliarG0({ ...base, prIa });
    expect(r).toMatchObject({ implementavel: true, trabalho_existente: prIa, forca_g1: true });
  });

  it('detalhe falso compatível com o item (sanidade do apoio)', () => {
    expect(detalheFalso({ numero: 1 }).status).toBe('em_atendimento');
  });
});
