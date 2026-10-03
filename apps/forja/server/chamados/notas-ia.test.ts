import { describe, expect, it } from 'vitest';
import {
  MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO,
  montarNotaDiagnostico,
  montarNotaEscalonamento,
  montarNotaFalhaResolucao,
  montarNotaResolucaoPr,
  montarTemplateSpec,
  nomeBranchResolucao,
} from '@chamados/shared';
import { classificarMensagem, extrairNotasIa, extrairPrIa, pareceSpec } from './notas-ia';
import { sinaisDoDetalhe } from './sinais';
import { detalheFalso, mensagemFalsa } from './servidor-falso.test-apoio';

/**
 * Teste de CONTRATO (specs/forja/07 §4, §13): o classificador reconhece a saída
 * REAL dos construtores de `@chamados/shared/triagem-notas.ts`. Se o Chamados
 * mudar o texto de uma nota, este teste quebra — não a produção.
 */

const ia = (corpo: string, visibilidade: 'interna' | 'publica' = 'interna') =>
  mensagemFalsa({ corpo, visibilidade, autor_nome: 'Assistente IA', autor_papel: 'agente_ia' });

/** Simula o vai-e-volta markdown → rich text → markdown (escapes de pontuação). */
const comEscapes = (s: string): string => s.replace(/([()[\]_*.-])/g, '\\$1');

const diagnostico = montarNotaDiagnostico({
  diagnostico: 'O relatório soma duas vezes o frete.',
  confianca: 'alta',
  complexidade: 'facil',
  naturezaAtual: 'problema',
  naturezaAjustada: null,
  prioridadeAplicada: null,
  prioridadeSugerida: null,
});
const branch = nomeBranchResolucao(42, 'Relatório de frete em dobro');
const pr = montarNotaResolucaoPr({
  branch,
  prUrl: 'https://github.com/acme/erp/pull/7',
  resumo: 'Remove a soma duplicada.',
  arquivos: ['src/relatorio.ts'],
});
const prSemUrl = montarNotaResolucaoPr({ branch, prUrl: null, resumo: 'x', arquivos: [] });
const spec = montarTemplateSpec({
  titulo: 'Novo campo',
  sistemaAlvoNome: 'ERP',
  sistemaAlvoStack: null,
  chamadoNumero: '42',
  complexidade: 'medio',
  pedidoResumo: 'Adicionar campo de observação no pedido.',
});

describe('classificarMensagem com os construtores reais', () => {
  it.each([
    ['diagnostico', diagnostico],
    ['pr', pr],
    ['pr', prSemUrl],
    ['falha_resolucao', montarNotaFalhaResolucao('timeout')],
    ['escalonamento', montarNotaEscalonamento('provider_indisponivel')],
    ['spec', spec],
  ])('%s', (tipo, corpo) => {
    expect(classificarMensagem(ia(corpo))?.tipo).toBe(tipo);
    expect(classificarMensagem(ia(comEscapes(corpo)))?.tipo).toBe(tipo);
  });

  it('pública "em revisão" da IA', () => {
    expect(classificarMensagem(ia(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO, 'publica'))?.tipo).toBe(
      'publica_em_revisao',
    );
    expect(classificarMensagem(ia('Outra resposta qualquer.', 'publica'))).toBeNull();
  });

  it('SPEC sem o template literal (heurística) e nota não classificada', () => {
    expect(classificarMensagem(ia('Objetivo: x\n\n## Critérios de aceite\n- [ ] y'))?.tipo).toBe(
      'spec',
    );
    expect(classificarMensagem(ia('Observação livre da IA.'))?.tipo).toBe('outra_ia');
    expect(pareceSpec('**SPEC** solta')).toBe(false);
  });

  it('só agente_ia: equipe, cliente e a própria Forja ficam de fora', () => {
    expect(
      classificarMensagem(
        mensagemFalsa({ corpo: diagnostico, autor_papel: 'operador', visibilidade: 'interna' }),
      ),
    ).toBeNull();
    expect(
      classificarMensagem(mensagemFalsa({ corpo: diagnostico, autor_papel: 'cliente' })),
    ).toBeNull();
  });
});

describe('extrairPrIa', () => {
  it('lê URL e branch do construtor real', () => {
    expect(extrairPrIa(pr)).toEqual({
      branch,
      numero_na_branch: 42,
      pr_url: 'https://github.com/acme/erp/pull/7',
    });
    expect(extrairPrIa(prSemUrl)).toMatchObject({ branch, pr_url: null });
  });

  it('tolera o markdown devolvido pela API (<url>, link, crases, escapes)', () => {
    const corpo = [
      'Resolução automática (Assistente IA) — Pull Request aguardando revisão',
      'Pull Request: [https://github.com/acme/erp/pull/9](https://github.com/acme/erp/pull/9)',
      `Branch: \`${comEscapes(branch)}\``,
    ].join('\n');
    expect(extrairPrIa(corpo)).toMatchObject({
      branch,
      pr_url: 'https://github.com/acme/erp/pull/9',
    });
    expect(extrairPrIa('Pull Request: <https://x.dev/pr/1>').pr_url).toBe('https://x.dev/pr/1');
  });
});

describe('extrairNotasIa — usa a MAIS RECENTE de cada tipo', () => {
  it('a segunda rodada de triagem substitui a primeira', () => {
    const d1 = ia(diagnostico);
    const d2 = ia(diagnostico.replace('duas vezes', 'três vezes'));
    const outra = ia('Comentário avulso.');
    const n = extrairNotasIa([d1, ia(spec), d2, outra]);
    expect(n.diagnostico?.mensagem.id).toBe(d2.id);
    expect(n.spec).not.toBeNull();
    expect(n.outras.map((o) => o.mensagem.id)).toEqual([outra.id]);
    expect(n.todas).toHaveLength(4);
  });
});

describe('sinaisDoDetalhe', () => {
  it('acende spec, diagnóstico e PR do PRÓPRIO chamado', () => {
    const s = sinaisDoDetalhe({
      chamado: detalheFalso({ numero: 42 }),
      mensagens: [ia(diagnostico), ia(spec), ia(pr)],
    });
    expect(s).toMatchObject({
      tem_spec_ia: true,
      tem_diagnostico_ia: true,
      tem_pr_ia: true,
      branch_ia: branch,
      pr_url_ia: 'https://github.com/acme/erp/pull/7',
      ia_silenciada: true,
    });
  });

  it('PR com branch de OUTRO chamado não acende', () => {
    const s = sinaisDoDetalhe({ chamado: detalheFalso({ numero: 7 }), mensagens: [ia(pr)] });
    expect(s.tem_pr_ia).toBe(false);
    expect(s.branch_ia).toBeNull();
  });
});
