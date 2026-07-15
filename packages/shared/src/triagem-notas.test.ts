import { describe, it, expect } from 'vitest';
import { Complexidade, Natureza, Prioridade } from './enums';
import {
  formatarPerguntasCliente,
  montarNotaDiagnostico,
  montarNotaEscalonamento,
  montarTemplateSpec,
  slugChamado,
  nomeBranchResolucao,
  montarMensagemCommit,
  montarTituloPr,
  montarCorpoPr,
  montarNotaResolucaoPr,
  montarNotaFalhaResolucao,
} from './triagem-notas';

describe('formatarPerguntasCliente', () => {
  it('numera as perguntas e limita a 5', () => {
    const txt = formatarPerguntasCliente(['A?', 'B?', 'C?', 'D?', 'E?', 'F?']);
    expect(txt).toContain('1. A?');
    expect(txt).toContain('5. E?');
    expect(txt).not.toContain('6.');
  });

  it('descarta perguntas vazias e cai num fallback objetivo quando não há nenhuma', () => {
    const txt = formatarPerguntasCliente(['   ', '']);
    expect(txt).toContain('1. ');
  });
});

describe('montarNotaDiagnostico', () => {
  it('aplica prioridade quando a IA a aplicou (chamado virgem)', () => {
    const nota = montarNotaDiagnostico({
      diagnostico: 'Timeout no serviço de pedidos.',
      confianca: 0.9,
      complexidade: Complexidade.facil,
      naturezaAtual: Natureza.problema,
      naturezaAjustada: Natureza.problema,
      prioridadeAplicada: Prioridade.alta,
      prioridadeSugerida: null,
    });
    expect(nota).toContain('Diagnóstico automático');
    expect(nota).toContain('Complexidade avaliada: facil');
    expect(nota).toContain('Prioridade ajustada automaticamente para: alta');
    expect(nota).not.toContain('Natureza reclassificada');
  });

  it('apenas sugere prioridade e registra reclassificação de natureza', () => {
    const nota = montarNotaDiagnostico({
      diagnostico: 'É um pedido de comportamento novo.',
      confianca: 0.8,
      complexidade: Complexidade.medio,
      naturezaAtual: Natureza.problema,
      naturezaAjustada: Natureza.alteracao,
      prioridadeAplicada: null,
      prioridadeSugerida: Prioridade.media,
    });
    expect(nota).toContain('Natureza reclassificada: problema → alteracao');
    expect(nota).toContain('Prioridade sugerida: media');
    expect(nota).toContain('já foi tocado por um operador');
  });
});

describe('montarNotaEscalonamento', () => {
  it('inclui o motivo normalizado sem stack trace', () => {
    expect(montarNotaEscalonamento('timeout')).toContain('Motivo: timeout.');
    expect(montarNotaEscalonamento('')).toContain('erro_desconhecido');
  });
});

describe('montarTemplateSpec', () => {
  it('produz todas as seções obrigatórias de specs/05 §7', () => {
    const spec = montarTemplateSpec({
      titulo: 'Filtro por data no relatório',
      sistemaAlvoNome: 'Loja',
      sistemaAlvoStack: 'bd: postgres',
      chamadoNumero: '42',
      complexidade: Complexidade.medio,
      pedidoResumo: 'Permitir filtrar o relatório por intervalo de datas.',
      mudancasPropostas: ['relatorio.ts: adicionar filtro de datas'],
      criteriosAceite: ['Filtro aplica intervalo corretamente'],
    });
    for (const secao of [
      '# SPEC — Filtro por data no relatório',
      '## Contexto',
      'Chamado: #42 | Natureza: alteracao | Complexidade: medio',
      '## Objetivo',
      '## Escopo',
      '## Estado atual',
      '## Comportamento desejado',
      '## Mudanças propostas',
      '## Critérios de aceite',
      '## Riscos e considerações',
      '## Estimativa',
    ]) {
      expect(spec).toContain(secao);
    }
    expect(spec).toContain('- [ ] Filtro aplica intervalo corretamente');
    expect(spec).toContain('relatorio.ts: adicionar filtro de datas');
  });

  it('preenche <a detalhar> onde faltam dados, mantendo a estrutura', () => {
    const spec = montarTemplateSpec({
      titulo: 'X',
      sistemaAlvoNome: 'Sistema',
      sistemaAlvoStack: null,
      chamadoNumero: '1',
      complexidade: Complexidade.facil,
      pedidoResumo: '',
    });
    expect(spec).toContain('<a detalhar>');
    expect(spec).toContain('## Critérios de aceite');
  });
});

describe('resolução automática — branch/commit/PR', () => {
  it('slugChamado remove acentos, espaços e capa o tamanho', () => {
    expect(slugChamado('Erro 500 ao Salvar Pedido (Ação!)')).toBe('erro-500-ao-salvar-pedido-acao');
    expect(slugChamado('')).toBe('chamado');
    expect(slugChamado('!!!')).toBe('chamado');
  });

  it('nomeBranchResolucao segue ia/chamado-<numero>-<slug>', () => {
    expect(nomeBranchResolucao(42, 'Erro ao salvar')).toBe('ia/chamado-42-erro-ao-salvar');
  });

  it('mensagem de commit referencia chamado e ExecucaoIA', () => {
    const msg = montarMensagemCommit({
      numero: 42,
      titulo: 'Erro ao salvar',
      execucaoId: 'exec-1',
      resumo: 'corrige o handler',
    });
    expect(msg).toContain('chamado #42');
    expect(msg).toContain('ExecucaoIA: exec-1');
    expect(msg).toContain('nunca faz merge');
  });

  it('corpo do PR traz diagnóstico, resumo, arquivos e o guardrail', () => {
    const corpo = montarCorpoPr({
      numero: 42,
      titulo: 'Erro ao salvar',
      diagnostico: 'NPE no handler',
      resumo: 'valida entrada',
      arquivos: ['app.js'],
      execucaoId: 'exec-1',
      chamadoUrl: 'https://acme.app/app/chamados/x',
    });
    expect(corpo).toContain('## Diagnóstico');
    expect(corpo).toContain('NPE no handler');
    expect(corpo).toContain('## Resumo da mudança');
    expect(corpo).toContain('- app.js');
    expect(corpo).toContain('https://acme.app/app/chamados/x');
    expect(corpo).toContain('Requer revisão humana');
    expect(
      montarTituloPr({ numero: 42, titulo: 'Erro', resumo: '', arquivos: [], execucaoId: 'e' }),
    ).toBe('Chamados #42: Erro');
  });

  it('nota de PR mostra link quando há prUrl e instrução manual quando não há', () => {
    const comPr = montarNotaResolucaoPr({
      branch: 'ia/chamado-1-x',
      prUrl: 'https://github.com/a/b/pull/3',
      resumo: 'r',
      arquivos: ['a.js'],
    });
    expect(comPr).toContain('Pull Request: https://github.com/a/b/pull/3');
    expect(comPr).toContain('ia/chamado-1-x');

    const semPr = montarNotaResolucaoPr({
      branch: 'ia/chamado-1-x',
      prUrl: null,
      resumo: 'r',
      arquivos: ['a.js'],
    });
    expect(semPr).toContain('manualmente');
    expect(semPr).toContain('ia/chamado-1-x');
  });

  it('nota de falha da resolução não expõe segredos e mantém o diagnóstico', () => {
    const nota = montarNotaFalhaResolucao('push_falhou');
    expect(nota).toContain('push_falhou');
    expect(nota).toContain('diagnóstico acima permanece');
  });
});
