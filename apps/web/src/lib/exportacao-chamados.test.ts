import { describe, it, expect } from 'vitest';
import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  EstimativaCusto,
} from '@chamados/shared';
import type { LinhaExportacaoFila, LinhaExportacaoPublica } from '@chamados/db';
import {
  COLUNAS_EXPORTACAO_EQUIPE,
  COLUNAS_EXPORTACAO_PUBLICA,
  linhaExportacaoEquipe,
  linhaExportacaoPublica,
  planilhaEquipe,
  planilhaPublica,
  nomeArquivoExportacao,
  nomeAbaExportacao,
} from './exportacao-chamados';
import { hrefExportacaoPortal, lerListaPortal, statusConsultadosPortal } from './portal-lista';

const criado = new Date('2026-11-10T13:00:00Z');
const atualizado = new Date('2026-11-17T15:30:00Z');

const EQUIPE: LinhaExportacaoFila = {
  id: 'id-1',
  numero: '1042',
  titulo: '=HYPERLINK("http://mal")',
  status: StatusChamado.resolvido,
  natureza: Natureza.problema,
  prioridade: Prioridade.alta,
  complexidade: Complexidade.facil,
  estimativa_custo: EstimativaCusto.B,
  custo_final: 180.5,
  ia_silenciada: true,
  fechar_automaticamente_em: null,
  operador_id: 'op',
  operador_nome: 'Marina',
  solicitante_nome: 'Cliente Um',
  solicitante_email: 'c1@a.dev',
  sistema_nome: null,
  categoria_nome: 'Financeiro',
  reaberto_count: 2,
  created_at: criado,
  updated_at: atualizado,
  resolvido_em: atualizado,
  fechado_em: null,
};

const PUBLICA: LinhaExportacaoPublica = {
  numero: '7',
  titulo: 'Erro no login',
  status: StatusChamado.em_atendimento,
  natureza: Natureza.duvida,
  prioridade: Prioridade.media,
  estimativa_custo: null,
  custo_final: null,
  solicitante_eh_voce: true,
  solicitante_nome: 'Cliente Um',
  sistema_nome: 'ERP',
  categoria_nome: null,
  reaberto_count: 0,
  created_at: criado,
  updated_at: atualizado,
  resolvido_em: null,
  fechado_em: null,
};

describe('exportação da equipe (D-045)', () => {
  it('uma célula por coluna, com rótulos pt-BR, números e datas tipados', () => {
    const linha = linhaExportacaoEquipe(EQUIPE);
    expect(linha).toHaveLength(COLUNAS_EXPORTACAO_EQUIPE.length);
    const porColuna = Object.fromEntries(COLUNAS_EXPORTACAO_EQUIPE.map((c, i) => [c, linha[i]]));
    expect(porColuna).toMatchObject({
      Nº: 1042,
      Status: 'Resolvido',
      Natureza: 'Problema',
      Prioridade: 'Alta',
      Complexidade: 'Fácil',
      Solicitante: 'Cliente Um',
      'E-mail do solicitante': 'c1@a.dev',
      'Sistema / categoria': 'Financeiro',
      Responsável: 'Marina',
      'Estimativa de custo': 'B · R$ 100 a R$ 200',
      'Custo final (R$)': 180.5,
      'Criado em': criado,
      'Atualizado em': atualizado,
      'Resolvido em': atualizado,
      'Fechado em': null,
      Reaberturas: 2,
    });
    // O título vai como veio: a neutralização de fórmula é do gerador (quotePrefix).
    expect(porColuna['Título']).toBe('=HYPERLINK("http://mal")');
  });

  it('planilha: datas nativas no fuso do produto, moeda no custo, aba avisa truncamento', () => {
    const p = planilhaEquipe([EQUIPE], false, 10_000);
    expect(p).toMatchObject({
      nomeAba: 'Chamados',
      datas: 'data',
      fusoHorario: 'America/Sao_Paulo',
    });
    expect(p.formatos?.[COLUNAS_EXPORTACAO_EQUIPE.indexOf('Custo final (R$)')]).toBe('moeda');
    expect(p.formatos?.filter(Boolean)).toHaveLength(1);
    expect(planilhaEquipe([], true, 10_000).nomeAba).toBe('Chamados (primeiros 10000)');
    expect(nomeAbaExportacao(true, 10_000).length).toBeLessThanOrEqual(31);
  });

  it('sem estimativa/complexidade/responsável: células vazias (null), não "—"', () => {
    const linha = linhaExportacaoEquipe({
      ...EQUIPE,
      complexidade: null,
      estimativa_custo: null,
      custo_final: null,
      operador_nome: null,
    });
    const i = (c: (typeof COLUNAS_EXPORTACAO_EQUIPE)[number]) =>
      COLUNAS_EXPORTACAO_EQUIPE.indexOf(c);
    expect(linha[i('Complexidade')]).toBeNull();
    expect(linha[i('Estimativa de custo')]).toBeNull();
    expect(linha[i('Custo final (R$)')]).toBeNull();
    expect(linha[i('Responsável')]).toBeNull();
  });
});

describe('exportação do portal — visão pública (specs/03 §7)', () => {
  it('nenhuma coluna interna', () => {
    const internas = ['Complexidade', 'Responsável', 'E-mail do solicitante'];
    for (const c of internas) {
      expect(COLUNAS_EXPORTACAO_PUBLICA as readonly string[]).not.toContain(c);
    }
    const linha = linhaExportacaoPublica(PUBLICA);
    expect(linha).toHaveLength(COLUNAS_EXPORTACAO_PUBLICA.length);
    expect(linha[COLUNAS_EXPORTACAO_PUBLICA.indexOf('Solicitante')]).toBe('Você');
    expect(
      linhaExportacaoPublica({ ...PUBLICA, solicitante_eh_voce: false })[
        COLUNAS_EXPORTACAO_PUBLICA.indexOf('Solicitante')
      ],
    ).toBe('Cliente Um');
    expect(planilhaPublica([PUBLICA], false, 10_000).colunas).toEqual([
      ...COLUNAS_EXPORTACAO_PUBLICA,
    ]);
  });

  it('o href de exportação do portal carrega o MESMO recorte (sem cursor)', () => {
    const e = lerListaPortal(
      new URLSearchParams('ver=todos&aba=historico&status=fechado&cursor=abc'),
    );
    expect(hrefExportacaoPortal(e)).toBe('/portal/exportar?ver=todos&aba=historico&status=fechado');
    expect(statusConsultadosPortal(e)).toEqual(['fechado']);
    // Status fora do grupo da aba é ignorado; busca varre tudo.
    const fora = lerListaPortal(new URLSearchParams('status=fechado'));
    expect(fora.statusFiltro).toBeUndefined();
    expect(statusConsultadosPortal(lerListaPortal(new URLSearchParams('q=erro')))).toBeUndefined();
  });
});

describe('nomeArquivoExportacao', () => {
  it('chamados-<slug>-<AAAA-MM-DD>.xlsx na data de São Paulo', () => {
    // 02:00 UTC de 18/11 ainda é 17/11 em São Paulo (UTC-3).
    expect(nomeArquivoExportacao('acme', new Date('2026-11-18T02:00:00Z'), false)).toBe(
      'chamados-acme-2026-11-17.xlsx',
    );
    expect(nomeArquivoExportacao('acme', new Date('2026-11-18T12:00:00Z'), true)).toBe(
      'chamados-acme-2026-11-18-parcial.xlsx',
    );
  });

  it('slug saneado para cabeçalho HTTP', () => {
    expect(nomeArquivoExportacao('Ácme "x"/../y', new Date('2026-11-17T12:00:00Z'), false)).toBe(
      'chamados-cme-x-y-2026-11-17.xlsx',
    );
    expect(nomeArquivoExportacao('***', new Date('2026-11-17T12:00:00Z'), false)).toBe(
      'chamados-tenant-2026-11-17.xlsx',
    );
  });
});
