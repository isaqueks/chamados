import { describe, expect, it } from 'vitest';
import {
  avaliarPublicacao,
  chavesDosMotivos,
  LIMITE_RESPOSTA_PUBLICA,
  validarRespostaPublica,
} from './validador-linguagem';

/**
 * Validador de linguagem (specs/forja/04 §8; 07 §10, §13): detectores de
 * `@chamados/shared` + léxico extra com fronteira Unicode + disponibilidade +
 * tamanho, e o "publicar mesmo assim" explícito.
 */

describe('léxico extra (fronteira Unicode)', () => {
  it('"Fizemos o merge da branch e o PR foi aprovado" é reprovada pelo léxico', () => {
    const v = validarRespostaPublica(
      'Fizemos o merge da branch e o PR foi aprovado.',
      'disponivel',
    );
    expect(v.ok).toBe(false);
    expect(v.lexico).toEqual(expect.arrayContaining(['merge', 'branch', 'PR']));
    expect(v.tecnico).toEqual([]);
  });

  it('"fizemos o merge da branch" → reprovado', () => {
    expect(validarRespostaPublica('Já fizemos o merge da branch.', 'pergunta').ok).toBe(false);
  });

  it('"próxima" NÃO casa com PR (o \\b ASCII casaria)', () => {
    const v = validarRespostaPublica(
      'Isso entra na próxima atualização. Programamos para breve.',
      'pergunta',
    );
    expect(v.lexico).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('"+tag" e palavras com o radical dentro passam', () => {
    for (const texto of [
      'Marque a opção +tag no cadastro do produto.',
      'O comitê aprovou a emergência do pedido.',
      'A apicultura e o bugio não são termos técnicos.',
    ]) {
      expect(validarRespostaPublica(texto, 'pergunta')).toMatchObject({ ok: true, lexico: [] });
    }
  });

  it('siglas são sensíveis a maiúsculas; o resto não', () => {
    expect(validarRespostaPublica('Veja o pr do cadastro.', 'pergunta').lexico).toEqual([]);
    expect(validarRespostaPublica('A api do sistema.', 'pergunta').lexico).toEqual([]);
    expect(validarRespostaPublica('Corrigimos um BUG no DEPLOY.', 'pergunta').lexico).toEqual(
      expect.arrayContaining(['bug', 'deploy']),
    );
    expect(validarRespostaPublica('A API mudou.', 'pergunta').lexico).toEqual(['API']);
  });

  it('flexões aportuguesadas e plurais', () => {
    const v = validarRespostaPublica(
      'O código foi mergeado e os commits, deployados.',
      'disponivel',
    );
    expect(v.lexico).toEqual(expect.arrayContaining(['merge', 'commit', 'deploy']));
  });

  it('motivo legível com posição exata', () => {
    const texto = 'Olá! A branch nova está pronta.';
    const m = validarRespostaPublica(texto, 'pergunta').motivos.find((x) => x.rotulo === 'branch')!;
    expect(texto.slice(m.inicio!, m.fim!)).toBe('branch');
    expect(m.chave).toBe('lexico:branch');
    expect(m.mensagem).toContain('branch');
  });
});

describe('detectores de @chamados/shared e disponibilidade', () => {
  it('conteúdo técnico e promessa', () => {
    const v = validarRespostaPublica(
      'Corrigimos o arquivo src/app.ts e o problema foi resolvido.',
      'disponivel',
    );
    expect(v.tecnico.length).toBeGreaterThan(0);
    expect(v.promessa.length).toBeGreaterThan(0);
    expect(v.ok).toBe(false);
  });

  it('promessa bloqueia até no tipo "disponivel" (07 §10)', () => {
    expect(validarRespostaPublica('O erro foi corrigido.', 'disponivel').ok).toBe(false);
  });

  it('disponibilidade só bloqueia em aguardando_publicacao', () => {
    const t = 'A mudança já está disponível e já pode usar.';
    expect(validarRespostaPublica(t, 'aguardando_publicacao').disponibilidade).toEqual([
      'já está disponível',
      'já pode usar',
    ]);
    expect(validarRespostaPublica(t, 'disponivel')).toMatchObject({
      ok: true,
      disponibilidade: [],
    });
    expect(
      validarRespostaPublica('Isso já está no ar, em produção.', 'aguardando_publicacao')
        .disponibilidade,
    ).toEqual(['no ar', 'em produção']);
  });

  it('tamanho: vazio e acima de 1.200', () => {
    expect(validarRespostaPublica('   ', 'pergunta').tamanho).toEqual(['vazia']);
    const v = validarRespostaPublica('a'.repeat(LIMITE_RESPOSTA_PUBLICA + 1), 'pergunta');
    expect(v).toMatchObject({ ok: false, tamanho: ['acima_do_limite'] });
  });
});

describe('avaliarPublicacao — "publicar mesmo assim"', () => {
  const v = validarRespostaPublica('O deploy sai amanhã.', 'pergunta');

  it('sem confirmação, bloqueia', () => {
    expect(avaliarPublicacao(v, null)).toEqual({
      permitido: false,
      motivos_nao_confirmados: ['lexico:deploy'],
    });
  });

  it('confirmação pelos MESMOS motivos libera', () => {
    expect(avaliarPublicacao(v, { motivos: chavesDosMotivos(v) }).permitido).toBe(true);
  });

  it('motivo novo exige nova confirmação', () => {
    const v2 = validarRespostaPublica('O deploy da branch sai amanhã.', 'pergunta');
    expect(avaliarPublicacao(v2, { motivos: ['lexico:deploy'] })).toEqual({
      permitido: false,
      motivos_nao_confirmados: ['lexico:branch'],
    });
  });

  it('tamanho nunca é dispensável', () => {
    const vazio = validarRespostaPublica('', 'pergunta');
    expect(avaliarPublicacao(vazio, { motivos: ['tamanho:vazia'] }).permitido).toBe(false);
  });

  it('texto ok publica sem confirmação', () => {
    expect(
      avaliarPublicacao(validarRespostaPublica('Tudo certo por aqui.', 'pergunta'), null).permitido,
    ).toBe(true);
  });
});
