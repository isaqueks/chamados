import { describe, it, expect } from 'vitest';
import {
  lerEstadoFila,
  paraFiltrosFila,
  serializarEstadoFila,
  hrefFila,
  hrefExportacaoFila,
  estadoLimpo,
  filtrosAtivos,
  contarMaisFiltros,
  temFiltroAtivo,
  ordemEfetiva,
  ordenacaoDaColuna,
  descreverOrdem,
  fraseOrdem,
  faixaDaPagina,
  ehDataIso,
  type NomesFila,
} from './fila-params';

const UUID_OP = '11111111-2222-4333-8444-555555555555';
const UUID_CLI = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_SIS = '99999999-8888-4777-8666-555555555555';
const UUID_CAT = '12345678-1234-4234-8234-123456789012';

const sp = (q: string) => new URLSearchParams(q);
const NOMES: NomesFila = {
  operadores: { [UUID_OP]: 'Marina Souza' },
  clientes: { [UUID_CLI]: 'Cliente Um' },
  sistemas: { [UUID_SIS]: 'ERP' },
  categorias: { [UUID_CAT]: 'Financeiro' },
};

describe('lerEstadoFila — padrões e situação (D-030)', () => {
  it('sem parâmetros: Em aberto, página 1, 25 por página, sem filtros', () => {
    const e = lerEstadoFila(sp(''));
    expect(e).toMatchObject({ situacao: 'abertos', pagina: 1, por: 25, responsavel: '' });
    expect(e.ordem).toBeUndefined();
    expect(temFiltroAtivo(e)).toBe(false);
  });

  it('status explícito define a situação; busca varre todos; situação explícita manda', () => {
    expect(lerEstadoFila(sp('status=resolvido')).situacao).toBe('encerrados');
    expect(lerEstadoFila(sp('q=boleto')).situacao).toBe('todos');
    expect(lerEstadoFila(sp('q=boleto&situacao=abertos')).situacao).toBe('abertos');
  });

  it('aceita objeto de searchParams do Next (string | string[])', () => {
    const e = lerEstadoFila({ prioridade: ['alta', 'baixa'], q: '  erro  ' });
    expect(e.prioridade).toBe('alta');
    expect(e.busca).toBe('erro');
  });
});

describe('lerEstadoFila — validação', () => {
  it('descarta enums, UUIDs e datas inválidos (nunca erro)', () => {
    const e = lerEstadoFila(
      sp(
        'status=xyz&prioridade=altissima&natureza=x&complexidade=y&estimativa=Z&responsavel=marina&solicitante=123&sistema=abc&de=2026-02-30&ate=ontem&ordem=titulo&por=7&pagina=-3',
      ),
    );
    expect(e.status).toBeUndefined();
    expect(e.prioridade).toBeUndefined();
    expect(e.natureza).toBeUndefined();
    expect(e.complexidade).toBeUndefined();
    expect(e.estimativa).toBeUndefined();
    expect(e.responsavel).toBe('');
    expect(e.solicitante).toBeUndefined();
    expect(e.sistema).toBeUndefined();
    expect(e.periodo).toBeUndefined();
    expect(e.ordem).toBeUndefined();
    expect(e.por).toBe(25);
    expect(e.pagina).toBe(1);
  });

  it('responsável: meus | nenhum | UUID; legado atribuicao= do dashboard', () => {
    expect(lerEstadoFila(sp('responsavel=meus')).responsavel).toBe('meus');
    expect(lerEstadoFila(sp('responsavel=nenhum')).responsavel).toBe('nenhum');
    expect(lerEstadoFila(sp(`responsavel=${UUID_OP.toUpperCase()}`)).responsavel).toBe(UUID_OP);
    expect(lerEstadoFila(sp('atribuicao=nao_atribuidos')).responsavel).toBe('nenhum');
    expect(lerEstadoFila(sp('atribuicao=meus')).responsavel).toBe('meus');
  });

  it('alvo: sistema e categoria são exclusivos (sistema vence)', () => {
    const e = lerEstadoFila(sp(`sistema=${UUID_SIS}&categoria=${UUID_CAT}`));
    expect(e.sistema).toBe(UUID_SIS);
    expect(e.categoria).toBeUndefined();
    expect(lerEstadoFila(sp(`categoria=${UUID_CAT}`)).categoria).toBe(UUID_CAT);
  });

  it('período: campo padrão "criado", datas invertidas são trocadas, um lado só vale', () => {
    expect(lerEstadoFila(sp('de=2026-11-30&ate=2026-11-01')).periodo).toEqual({
      campo: 'criado',
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(lerEstadoFila(sp('periodo=atualizado&ate=2026-11-17')).periodo).toEqual({
      campo: 'atualizado',
      ate: '2026-11-17',
    });
    // `periodo` sem datas não é filtro.
    expect(lerEstadoFila(sp('periodo=atualizado')).periodo).toBeUndefined();
  });

  it('ordenação e paginação', () => {
    const e = lerEstadoFila(sp('ordem=prioridade&dir=asc&por=100&pagina=3'));
    expect(e.ordem).toEqual({ campo: 'prioridade', direcao: 'asc' });
    expect(e.por).toBe(100);
    expect(e.pagina).toBe(3);
    expect(lerEstadoFila(sp('ordem=criado&dir=qualquer')).ordem?.direcao).toBe('desc');
  });

  it('ehDataIso rejeita datas fora do calendário', () => {
    expect(ehDataIso('2026-11-17')).toBe(true);
    expect(ehDataIso('2026-02-29')).toBe(false);
    expect(ehDataIso('2028-02-29')).toBe(true);
    expect(ehDataIso('17/11/2026')).toBe(false);
  });
});

describe('paraFiltrosFila', () => {
  it('mapeia responsável para atribuicao/operador_id e o resto 1:1', () => {
    const e = lerEstadoFila(
      sp(
        `responsavel=${UUID_OP}&solicitante=${UUID_CLI}&categoria=${UUID_CAT}&estimativa=sem_estimativa&de=2026-11-01&pagina=2&por=50&ordem=numero&dir=asc`,
      ),
    );
    const f = paraFiltrosFila(e);
    expect(f).toMatchObject({
      operador_id: UUID_OP,
      cliente_id: UUID_CLI,
      categoria_id: UUID_CAT,
      estimativa_custo: 'sem_estimativa',
      periodo: { campo: 'criado', de: '2026-11-01' },
      ordenacao: { campo: 'numero', direcao: 'asc' },
      pagina: 2,
      limite: 50,
      situacao: 'abertos',
    });
    expect(f.atribuicao).toBeUndefined();
    expect(paraFiltrosFila(lerEstadoFila(sp('responsavel=meus'))).atribuicao).toBe('meus');
    expect(paraFiltrosFila(lerEstadoFila(sp('responsavel=nenhum'))).atribuicao).toBe(
      'nao_atribuidos',
    );
  });

  it('exportação não pagina', () => {
    const f = paraFiltrosFila(lerEstadoFila(sp('pagina=4&por=100')), false);
    expect(f.pagina).toBeUndefined();
    expect(f.limite).toBeUndefined();
  });
});

describe('URL canônica', () => {
  it('ida e volta preserva o estado; situação sempre explícita; padrões omitidos', () => {
    const url = `q=erro&situacao=todos&status=fechado&prioridade=alta&responsavel=${UUID_OP}&natureza=problema&complexidade=facil&estimativa=B&solicitante=${UUID_CLI}&sistema=${UUID_SIS}&periodo=atualizado&de=2026-10-01&ate=2026-10-31&ordem=criado&dir=asc&por=50&pagina=2`;
    const e = lerEstadoFila(sp(url));
    expect(lerEstadoFila(serializarEstadoFila(e))).toEqual(e);
    const padrao = serializarEstadoFila(lerEstadoFila(sp('')));
    expect(padrao.toString()).toBe('situacao=abertos');
  });

  it('mudar filtro volta à página 1; mudar só a página preserva o resto', () => {
    const e = lerEstadoFila(sp('pagina=3&prioridade=alta'));
    expect(hrefFila(e, { natureza: 'duvida' as never })).not.toContain('pagina=');
    const prox = hrefFila(e, { pagina: 4 });
    expect(prox).toContain('pagina=4');
    expect(prox).toContain('prioridade=alta');
  });

  it('trocar de situação descarta status de outra situação (D-030)', () => {
    const e = lerEstadoFila(sp('situacao=encerrados&status=fechado'));
    expect(hrefFila(e, { situacao: 'abertos' })).not.toContain('status=');
    expect(hrefFila(e, { situacao: 'todos' })).toContain('status=fechado');
  });

  it('exportação leva o MESMO recorte, sem paginação', () => {
    const e = lerEstadoFila(sp('pagina=3&por=100&prioridade=urgente&responsavel=nenhum'));
    const h = hrefExportacaoFila(e);
    expect(h.startsWith('/app/chamados/exportar?')).toBe(true);
    expect(h).toContain('prioridade=urgente');
    expect(h).toContain('responsavel=nenhum');
    expect(h).not.toContain('pagina=');
    expect(h).not.toContain('por=');
  });

  it('estadoLimpo zera filtros, preserva situação (aba), ordem e tamanho de página', () => {
    const e = lerEstadoFila(sp('q=x&prioridade=alta&ordem=numero&por=50&situacao=todos'));
    const l = estadoLimpo(e);
    expect(l).toMatchObject({ busca: '', situacao: 'todos', por: 50, pagina: 1 });
    expect(l.prioridade).toBeUndefined();
    expect(l.ordem).toEqual({ campo: 'numero', direcao: 'desc' });
    // "Limpar tudo" dos chips mantém a busca (ela não é chip).
    expect(estadoLimpo(e, { manterBusca: true }).busca).toBe('x');
  });
});

describe('chips de filtros ativos', () => {
  it('lista na ordem da barra, com nomes resolvidos e remoção', () => {
    const e = lerEstadoFila(
      sp(
        `responsavel=${UUID_OP}&prioridade=urgente&natureza=problema&categoria=${UUID_CAT}&solicitante=${UUID_CLI}&estimativa=I&de=2026-11-01&ate=2026-11-01`,
      ),
    );
    const chips = filtrosAtivos(e, NOMES);
    expect(chips.map((c) => c.chave)).toEqual([
      'responsavel',
      'prioridade',
      'natureza',
      'categoria',
      'solicitante',
      'estimativa',
      'periodo',
    ]);
    expect(chips.map((c) => c.valor)).toEqual([
      'Marina Souza',
      'Urgente',
      'Problema',
      'Financeiro',
      'Cliente Um',
      'Isento (R$ 0)',
      'Criado em 01/11/2026',
    ]);
    const semResp = hrefFila(e, chips[0]!.remover);
    expect(semResp).not.toContain('responsavel=');
    expect(semResp).toContain('prioridade=urgente');
  });

  it('busca e situação não viram chip; ids sem nome caem em rótulo neutro', () => {
    const e = lerEstadoFila(sp(`q=x&situacao=todos&responsavel=${UUID_CLI}`));
    const chips = filtrosAtivos(e, NOMES);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.valor).toBe('Operador removido');
  });

  it('contador de "Mais filtros" considera só as dimensões do painel', () => {
    const e = lerEstadoFila(
      sp(`prioridade=alta&responsavel=meus&natureza=duvida&sistema=${UUID_SIS}&ate=2026-01-01`),
    );
    expect(contarMaisFiltros(e)).toBe(3);
  });
});

describe('ordenação', () => {
  it('padrão: atualizado desc; com busca full-text: relevância', () => {
    const e = lerEstadoFila(sp(''));
    expect(ordemEfetiva(e, false)).toEqual({ campo: 'atualizado', direcao: 'desc' });
    expect(ordemEfetiva(e, true)).toBeNull();
    expect(descreverOrdem(null)).toBe('Relevância');
    expect(fraseOrdem(null)).toBe('relevância');
    expect(fraseOrdem({ campo: 'atualizado', direcao: 'desc' })).toBe(
      'última atualização (mais recentes primeiro)',
    );
    expect(fraseOrdem({ campo: 'numero', direcao: 'asc' })).toBe('número (menor primeiro)');
    expect(descreverOrdem({ campo: 'prioridade', direcao: 'desc' })).toBe(
      'Prioridade · mais urgentes',
    );
  });

  it('clique na coluna: inativa → desc; ativa desc → asc; asc → desc', () => {
    const e = lerEstadoFila(sp('prioridade=alta&pagina=2'));
    const atual = ordenacaoDaColuna(e, 'atualizado', false);
    expect(atual.direcao).toBe('desc');
    expect(atual.href).toContain('ordem=atualizado&dir=asc');
    expect(atual.href).not.toContain('pagina=');
    const prio = ordenacaoDaColuna(e, 'prioridade', false);
    expect(prio.direcao).toBeNull();
    expect(prio.href).toContain('ordem=prioridade&dir=desc');
    const asc = lerEstadoFila(sp('ordem=numero&dir=asc'));
    expect(ordenacaoDaColuna(asc, 'numero', false).href).toContain('dir=desc');
    // Em relevância nenhuma coluna está ativa.
    expect(ordenacaoDaColuna(lerEstadoFila(sp('q=erro')), 'atualizado', true).direcao).toBeNull();
  });
});

describe('faixaDaPagina', () => {
  it('calcula "de–até" da página', () => {
    expect(faixaDaPagina(1, 25, 25)).toEqual({ de: 1, ate: 25 });
    expect(faixaDaPagina(3, 25, 7)).toEqual({ de: 51, ate: 57 });
    expect(faixaDaPagina(2, 50, 0)).toEqual({ de: 0, ate: 0 });
  });
});
