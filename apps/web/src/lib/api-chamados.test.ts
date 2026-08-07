import { describe, it, expect } from 'vitest';
import { Papel, StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import type {
  ChamadoInterno,
  ChamadoCliente,
  MensagemInterna,
  MensagemCliente,
} from '@chamados/shared';
import {
  parsearFiltros,
  projetarItemLista,
  projetarDetalhe,
  projetarMensagens,
  idsDeChamados,
  type Nomes,
} from './api-chamados';

/**
 * Contrato da API `/api/v1` (specs/11 §4): parsing de filtros e projeções.
 *
 * O teste mais importante aqui é o da FRONTEIRA POR PAPEL: a view do cliente
 * (produzida pelo serializer de specs/03 §7) não tem `complexidade` nem
 * `visibilidade`, e a projeção não pode inventá-las — nem como `null`, que já
 * revelaria a existência do campo interno.
 */

const NOMES: Nomes = {
  usuarios: new Map([
    ['u-cli', { nome: 'Cliente Ana', papel: Papel.cliente }],
    ['u-op', { nome: 'Operador Bruno', papel: Papel.operador }],
    ['u-ia', { nome: 'Assistente', papel: Papel.agente_ia }],
  ]),
  sistemas: new Map([['s-1', 'ERP Financeiro']]),
  categorias: new Map([['c-1', 'Geral']]),
};

const BASE = {
  id: 'ch-1',
  numero: '42',
  sistema_alvo_id: 's-1',
  categoria_id: null,
  cliente_id: 'u-cli',
  titulo: 'Boleto não gera',
  descricao_json: {},
  descricao_html: '<p>Ao clicar em <strong>gerar</strong> a tela fica branca.</p>',
  status: StatusChamado.em_atendimento,
  natureza: Natureza.problema,
  prioridade: Prioridade.alta,
  resolvido_em: null,
  fechar_automaticamente_em: null,
  fechado_em: null,
  reaberto_count: 0,
  created_at: new Date('2026-08-01T10:00:00Z'),
  updated_at: new Date('2026-08-02T11:30:00Z'),
};

const CHAMADO_EQUIPE: ChamadoInterno = {
  ...BASE,
  tenant_id: 't-1',
  operador_id: 'u-op',
  complexidade: Complexidade.facil,
  ia_silenciada: false,
};

const CHAMADO_CLIENTE: ChamadoCliente = { ...BASE };

describe('parsearFiltros', () => {
  const sp = (q: string) => new URLSearchParams(q);

  it('aceita lista de status separada por vírgula', () => {
    const r = parsearFiltros(sp('status=novo,em_triagem'));
    expect(r.ok && r.filtros.status).toEqual([StatusChamado.novo, StatusChamado.em_triagem]);
  });

  it('REJEITA status inválido em vez de ignorar o filtro', () => {
    // Ignorar devolveria "todos os chamados" fingindo ter filtrado (specs/11 §4.1).
    const r = parsearFiltros(sp('status=aberto'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toMatch(/Status inválido/);
  });

  it('rejeita natureza e prioridade fora do domínio', () => {
    expect(parsearFiltros(sp('natureza=bug')).ok).toBe(false);
    expect(parsearFiltros(sp('prioridade=critica')).ok).toBe(false);
  });

  it('aceita atribuicao por palavra-chave ou UUID de operador', () => {
    const kw = parsearFiltros(sp('atribuicao=nao_atribuido'));
    expect(kw.ok && kw.filtros.atribuicao).toBe('nao_atribuido');

    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const porOp = parsearFiltros(sp(`atribuicao=${uuid}`));
    expect(porOp.ok && porOp.filtros.atribuicao).toEqual({ operador_id: uuid });

    expect(parsearFiltros(sp('atribuicao=marina')).ok).toBe(false);
  });

  it('valida a faixa do limite', () => {
    expect(parsearFiltros(sp('limite=50')).ok).toBe(true);
    expect(parsearFiltros(sp('limite=0')).ok).toBe(false);
    expect(parsearFiltros(sp('limite=101')).ok).toBe(false);
    expect(parsearFiltros(sp('limite=abc')).ok).toBe(false);
    expect(parsearFiltros(sp('limite=2.5')).ok).toBe(false);
  });

  it('sem parâmetros, não inventa filtro nenhum', () => {
    const r = parsearFiltros(sp(''));
    expect(r.ok && Object.keys(r.filtros)).toEqual([]);
  });
});

describe('projeções de chamado', () => {
  it('equipe recebe complexidade e operador', () => {
    const item = projetarItemLista(CHAMADO_EQUIPE, NOMES);
    expect(item.complexidade).toBe(Complexidade.facil);
    expect(item.operador_nome).toBe('Operador Bruno');
    expect(item.numero).toBe(42);
    expect(item.sistema_nome).toBe('ERP Financeiro');
  });

  it('cliente NÃO recebe complexidade nem operador — nem como null', () => {
    const item = projetarItemLista(CHAMADO_CLIENTE, NOMES);
    expect('complexidade' in item).toBe(false);
    expect('operador_nome' in item).toBe(false);
    // O que ele pode ver continua lá.
    expect(item.status).toBe(StatusChamado.em_atendimento);
    expect(item.solicitante_nome).toBe('Cliente Ana');
  });

  it('detalhe entrega a descrição em TEXTO puro (sem HTML)', () => {
    const d = projetarDetalhe(CHAMADO_EQUIPE, NOMES);
    expect(d.descricao).toBe('Ao clicar em gerar a tela fica branca.');
    expect(String(d.descricao)).not.toMatch(/</);
  });

  it('detalhe do cliente não expõe ia_silenciada (flag interna)', () => {
    expect('ia_silenciada' in projetarDetalhe(CHAMADO_CLIENTE, NOMES)).toBe(false);
    expect(projetarDetalhe(CHAMADO_EQUIPE, NOMES).ia_silenciada).toBe(false);
  });

  it('datas saem em ISO-8601', () => {
    const item = projetarItemLista(CHAMADO_EQUIPE, NOMES);
    expect(item.created_at).toBe('2026-08-01T10:00:00.000Z');
  });

  it('idsDeChamados coleta solicitante, operador, sistema e categoria', () => {
    const ids = idsDeChamados([CHAMADO_EQUIPE]);
    expect(ids.usuarios).toContain('u-cli');
    expect(ids.usuarios).toContain('u-op');
    expect(ids.sistemas).toContain('s-1');
  });
});

describe('projetarMensagens', () => {
  const publica: MensagemInterna = {
    id: 'm-1',
    chamado_id: 'ch-1',
    autor_id: 'u-cli',
    visibilidade: 'publica',
    corpo_json: {},
    corpo_html: '<p>Bom dia</p><p>Segue o print.</p>',
    created_at: new Date('2026-08-01T10:05:00Z'),
  };
  const interna: MensagemInterna = {
    ...publica,
    id: 'm-2',
    autor_id: 'u-ia',
    visibilidade: 'interna',
    corpo_html: '<p>Diagnóstico: falha em BoletoService.</p>',
  };

  it('equipe vê a visibilidade demarcada em cada item', () => {
    const r = projetarMensagens([publica, interna], NOMES);
    expect(r.map((m) => m.visibilidade)).toEqual(['publica', 'interna']);
    expect(r[1]!.autor_nome).toBe('Assistente');
    expect(r[1]!.autor_papel).toBe(Papel.agente_ia);
  });

  it('item já serializado para cliente não ganha o campo visibilidade', () => {
    // O serializer de specs/03 §7 remove `visibilidade`; a projeção não a recria.
    const doCliente: MensagemCliente = {
      id: 'm-1',
      autor_id: 'u-cli',
      corpo_json: {},
      corpo_html: '<p>Bom dia</p>',
      created_at: publica.created_at,
    };
    const r = projetarMensagens([doCliente], NOMES);
    expect('visibilidade' in r[0]!).toBe(false);
  });

  it('corpo vira texto com quebras de parágrafo preservadas', () => {
    const r = projetarMensagens([publica], NOMES);
    expect(r[0]!.corpo).toBe('Bom dia\nSegue o print.');
  });
});
