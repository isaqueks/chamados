import { describe, it, expect } from 'vitest';
import { Complexidade, ConfiancaAnalise, Natureza, Prioridade } from './enums';
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
  detectarConteudoTecnico,
  montarAvisoRespostaRebaixada,
  detectarPromessaResolucao,
  montarAvisoPromessaRebaixada,
  RESPOSTA_PUBLICA_FALLBACK,
  MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO,
} from './triagem-notas';

describe('formatarPerguntasCliente', () => {
  it('numera as perguntas e limita a 5', () => {
    const txt = formatarPerguntasCliente(['A?', 'B?', 'C?', 'D?', 'E?', 'F?']);
    expect(txt).toContain('1. A?');
    expect(txt).toContain('5. E?');
    expect(txt).not.toContain('6.');
  });

  it('sem perguntas válidas devolve null — JAMAIS o questionário genérico (incidente 2026-07-22)', () => {
    // Sem pergunta real, não há mensagem: o pipeline escalona a humano em vez
    // de publicar um "detalhe o passo a passo" fora de contexto.
    expect(formatarPerguntasCliente([])).toBeNull();
    expect(formatarPerguntasCliente(['   ', ''])).toBeNull();
  });
});

describe('montarNotaDiagnostico', () => {
  it('aplica prioridade quando a IA a aplicou (chamado virgem)', () => {
    const nota = montarNotaDiagnostico({
      diagnostico: 'Timeout no serviço de pedidos.',
      confianca: ConfiancaAnalise.alta,
      complexidade: Complexidade.facil,
      naturezaAtual: Natureza.problema,
      naturezaAjustada: Natureza.problema,
      prioridadeAplicada: Prioridade.alta,
      prioridadeSugerida: null,
    });
    expect(nota).toContain('Diagnóstico automático');
    // D-025: confiança categórica com rótulo pt-BR, nunca "0.90".
    expect(nota).toContain('Confiança da análise: alta');
    expect(nota).toContain('Complexidade avaliada: facil');
    expect(nota).toContain('Prioridade ajustada automaticamente para: alta');
    expect(nota).not.toContain('Natureza reclassificada');
  });

  it('apenas sugere prioridade e registra reclassificação de natureza', () => {
    const nota = montarNotaDiagnostico({
      diagnostico: 'É um pedido de comportamento novo.',
      confianca: ConfiancaAnalise.media,
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

// ---------------------------------------------------------------------------
// Separação técnica/pública (D-015) — validador conservador
// ---------------------------------------------------------------------------

describe('detectarConteudoTecnico', () => {
  // Mensagens de atendimento legítimas: NÃO podem disparar (sem falso-positivo).
  const limpas: Array<[string, string]> = [
    [
      'confirmação de entendimento',
      'Entendi seu pedido: adicionar um filtro por data no relatório. Nossa equipe já está analisando e retorna em breve.',
    ],
    [
      'pergunta ao cliente com usuário(s)',
      'Olá! Para avançar, poderia informar em qual tela isso acontece e qual usuário(s) é afetado?',
    ],
    [
      'valor monetário com parênteses',
      'O valor de R$ 1.000,00 (mil reais) está correto no seu cadastro?',
    ],
    [
      'exemplo e pontuação',
      'Vamos priorizar seu caso. Por exemplo, na próxima semana já teremos um retorno. Obrigado!',
    ],
    ['fallback padrão é limpo', RESPOSTA_PUBLICA_FALLBACK],
    ['agradecimento simples', 'Perfeito, obrigado pela informação! Já estamos cuidando disso.'],
  ];
  for (const [nome, texto] of limpas) {
    it(`NÃO marca como técnica: ${nome}`, () => {
      expect(detectarConteudoTecnico(texto).tecnica).toBe(false);
    });
  }

  // Mensagens com cara de técnico: DEVEM disparar.
  const tecnicas: Array<[string, string]> = [
    [
      'caminho + arquivo + função',
      'O erro ocorre em src/pedidos/salvar.js na função salvarPedido() quando o valor é nulo.',
    ],
    ['bloco de código', 'Rode isto:\n```js\nconsole.log(pedido)\n```'],
    ['SQL', 'Basta executar SELECT * FROM clientes WHERE ativo = true'],
    ['caminho windows + extensão', 'Veja o arquivo C:\\Users\\dev\\app\\index.ts na linha 40.'],
    ['stack trace', 'A falha: at Object.handler (/app/server.js:12:9) durante o commit.'],
    ['chamada de método', 'A causa é a chamada repo.buscarPedido(id) retornando indefinido.'],
    ['arquivo .sql solto', 'O script migration_0007.sql não rodou no ambiente.'],
  ];
  for (const [nome, texto] of tecnicas) {
    it(`marca como técnica: ${nome}`, () => {
      const d = detectarConteudoTecnico(texto);
      expect(d.tecnica).toBe(true);
      expect(d.motivos.length).toBeGreaterThan(0);
    });
  }

  it('texto vazio não é técnico', () => {
    expect(detectarConteudoTecnico('').tecnica).toBe(false);
    expect(detectarConteudoTecnico('   ').tecnica).toBe(false);
  });
});

describe('montarAvisoRespostaRebaixada', () => {
  it('preserva o texto original e cita o aviso e os padrões', () => {
    const aviso = montarAvisoRespostaRebaixada('O bug está em src/app.js', [
      'caminho de arquivo',
      'arquivo de código',
    ]);
    expect(aviso).toContain('rebaixada pelo validador');
    expect(aviso).toContain('Padrões detectados: caminho de arquivo, arquivo de código.');
    expect(aviso).toContain('src/app.js');
  });

  it('omite a linha de padrões quando não há motivos', () => {
    const aviso = montarAvisoRespostaRebaixada('texto', []);
    expect(aviso).not.toContain('Padrões detectados');
    expect(aviso).toContain('texto');
  });
});

describe('detectarPromessaResolucao (D-022)', () => {
  it.each([
    'Boa notícia! Já resolvi o problema do relatório.',
    'Identificamos a causa e corrigimos o cálculo do desconto.',
    'O erro foi corrigido e não deve mais acontecer.',
    'O problema relatado já está resolvido.',
    'A correção foi aplicada com sucesso.',
    'Pode testar novamente: o sistema voltou a funcionar.',
    'Fizemos um ajuste e o cadastro já está funcionando.',
    'Apliquei a mudança que você pediu.',
  ])('detecta afirmação de correção concluída: %s', (texto) => {
    const d = detectarPromessaResolucao(texto);
    expect(d.promete).toBe(true);
    expect(d.motivos.length).toBeGreaterThan(0);
  });

  it.each([
    'Nossa equipe está analisando o seu chamado e em breve retornamos.',
    'Vamos corrigir esse comportamento e avisaremos quando estiver disponível.',
    'O problema será resolvido pela nossa equipe técnica.',
    'Entendi seu pedido: você gostaria de alterar a ordem dos campos, certo?',
    'Assim que a correção for publicada, avisaremos por aqui.',
    'Estamos cuidando disso com prioridade.',
  ])('NÃO dispara com futuro/intenção/atendimento comum: %s', (texto) => {
    expect(detectarPromessaResolucao(texto).promete).toBe(false);
  });

  it('texto vazio não promete nada', () => {
    expect(detectarPromessaResolucao('')).toEqual({ promete: false, motivos: [] });
  });
});

describe('montarAvisoPromessaRebaixada / mensagem de correção em revisão (D-022)', () => {
  it('preserva o original, explica que era promessa falsa e cita os padrões', () => {
    const aviso = montarAvisoPromessaRebaixada('Já resolvi o problema!', ['correção em 1ª pessoa']);
    expect(aviso).toContain('rebaixada pelo validador');
    expect(aviso).toContain('PROPOSTA');
    expect(aviso).toContain('Padrões detectados: correção em 1ª pessoa.');
    expect(aviso).toContain('Já resolvi o problema!');
  });

  it('a mensagem pública de PR em revisão não promete resolução nem vaza técnica', () => {
    expect(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO).toContain('em revisão');
    expect(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO).toContain('nada muda no sistema');
    // Não pode disparar os próprios validadores.
    expect(detectarConteudoTecnico(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO).tecnica).toBe(false);
    expect(detectarPromessaResolucao(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO).promete).toBe(false);
    // Nunca menciona PR/branch/merge (jargão) ao cliente.
    expect(MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO).not.toMatch(/\b(PR|pull request|branch|merge)\b/i);
  });
});
