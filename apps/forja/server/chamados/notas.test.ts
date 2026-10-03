import { describe, expect, it } from 'vitest';
import {
  contemMarcador,
  LIMITE_CORPO_API,
  marcadorForja,
  montarMensagemModelo,
  montarNotaConclusao,
  montarNotaDescarte,
  montarNotaInicio,
  temMarcadorForja,
  type DadosNotaConclusao,
} from './notas';
import { detectarSegredos } from './detector-segredos';
import { validarRespostaPublica } from './validador-linguagem';

/** Textos da Forja no Chamados (specs/forja/07 §3, §9, §10). */

const EXEC = '0b5f3c1e-1111-4222-8333-944455556666';

const conclusao: DadosNotaConclusao = {
  execucaoId: EXEC,
  branch: 'forja/chamado-12-frete',
  shaMerge: '3f9a1c0d2b4e5f60718293a4b5c6d7e8f9012345',
  destino: 'main',
  modoEntrega: 'merge_e_push',
  nivelVerificacao: 'e2e_automatizado',
  resumo: 'Remove a soma duplicada do frete.',
  arquivos: ['src/relatorio.ts'],
  alteraUi: false,
  evidenciaVisual: 'nao_se_aplica',
  telas: [],
};

describe('notas internas', () => {
  it('conclusão no formato de 07 §9 com rodapé', () => {
    const n = montarNotaConclusao(conclusao);
    expect(n.split('\n')[0]).toBe('Implementação local (Forja) — aprovada e integrada');
    expect(n).toContain('Branch: forja/chamado-12-frete');
    expect(n).toContain(`Commit: ${conclusao.shaMerge}`);
    expect(n).toContain('Destino: main (merge e push)');
    expect(n).toContain('Nível de verificação: e2e automatizado');
    expect(n).toContain('Resumo da mudança:');
    expect(n).toContain('Arquivos alterados:\n- src/relatorio.ts');
    expect(n.endsWith(`[forja:${EXEC}:conclusao]`)).toBe(true);
    expect(detectarSegredos(n).ok).toBe(true);
  });

  it('altera_ui: lista as telas; sem prints, diz o motivo e "aprovado sem prints"', () => {
    const com = montarNotaConclusao({
      ...conclusao,
      alteraUi: true,
      evidenciaVisual: 'completa',
      telas: [{ titulo: 'Pedidos', o_que_mudou_para_quem_usa: 'Novo campo Observação.' }],
    });
    expect(com).toContain(
      `Prints antes/depois em 1 tela, disponíveis na Forja (execução ${EXEC}):`,
    );
    expect(com).toContain('- Pedidos: Novo campo Observação.');
    const sem = montarNotaConclusao({
      ...conclusao,
      alteraUi: true,
      evidenciaVisual: 'sem_evidencia_visual',
      motivoSemPrints: 'app não subiu',
      aprovadoSemPrints: true,
    });
    expect(sem).toContain('Alteração de interface sem prints: app não subiu (aprovado sem prints)');
  });

  it('trunca acima de 50.000 caracteres sem perder o rodapé', () => {
    const n = montarNotaConclusao({ ...conclusao, resumo: 'linha longa\n'.repeat(6000) });
    expect(n.length).toBeLessThanOrEqual(LIMITE_CORPO_API);
    expect(n).toContain(`relatório completo na Forja, execução ${EXEC}`);
    expect(contemMarcador(n, EXEC, 'conclusao')).toBe(true);
  });

  it('início e descarte com os marcadores próprios', () => {
    const i = montarNotaInicio({ execucaoId: EXEC, branch: 'forja/chamado-12-frete' });
    expect(i).toContain('Implementação local iniciada (Forja)');
    expect(contemMarcador(i, EXEC, 'inicio')).toBe(true);
    expect(contemMarcador(i, EXEC, 'conclusao')).toBe(false);
    const d = montarNotaDescarte({ execucaoId: EXEC, motivo: 'pedido mudou' });
    expect(d).toContain('Motivo: pedido mudou');
    expect(contemMarcador(d, EXEC, 'descarte')).toBe(true);
  });

  it('marcador sobrevive aos escapes do markdown devolvido', () => {
    const devolvido = `texto\n\n\\[forja:${EXEC}:conclusao\\]`;
    expect(contemMarcador(devolvido, EXEC, 'conclusao')).toBe(true);
    expect(temMarcadorForja(devolvido)).toBe(true);
    expect(marcadorForja('x', 'inicio')).toBe('[forja:x:inicio]');
  });
});

describe('mensagens-modelo (07 §10) passam no validador', () => {
  it('pergunta', () => {
    const m = montarMensagemModelo('pergunta', {
      solicitanteNome: 'Maria Souza',
      perguntas: ['O campo deve ser obrigatório?', 'Vale para todas as filiais?'],
    });
    expect(m.startsWith('Olá, Maria! Para seguirmos')).toBe(true);
    expect(m).toContain('1. O campo deve ser obrigatório?\n2. Vale para todas as filiais?');
    expect(validarRespostaPublica(m, 'pergunta').ok).toBe(true);
  });

  it('aguardando_publicacao (sem prometer aviso futuro)', () => {
    const m = montarMensagemModelo('aguardando_publicacao', {
      solicitanteNome: null,
      oQueMuda: 'o pedido passa a ter um campo de observação.',
    });
    expect(m.startsWith('Olá! A mudança que você pediu foi preparada')).toBe(true);
    expect(m).not.toMatch(/avisaremos/i);
    expect(validarRespostaPublica(m, 'aguardando_publicacao').ok).toBe(true);
  });

  it('disponivel', () => {
    const m = montarMensagemModelo('disponivel', {
      solicitanteNome: '  João  ',
      oQueMuda: 'o relatório de frete mostra o valor uma vez só.',
    });
    expect(m).toContain('Olá, João! A mudança que você pediu já está disponível no sistema.');
    expect(validarRespostaPublica(m, 'disponivel').ok).toBe(true);
  });

  it('campos obrigatórios', () => {
    expect(() =>
      montarMensagemModelo('pergunta', { solicitanteNome: 'A', perguntas: [] }),
    ).toThrow();
    expect(() => montarMensagemModelo('disponivel', { solicitanteNome: 'A' })).toThrow();
  });
});
