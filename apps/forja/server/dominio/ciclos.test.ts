import { describe, expect, it } from 'vitest';
import { achadoFalso, SHA_A, vereditoFalso } from './apoio-testes';
import {
  achadosRepetidos,
  decidirAposVeredito,
  decidirRecusa,
  decidirSaidaInvalida,
  maisUmCicloExigeConfirmacao,
  semAtividade,
  tetoPorChamadoAtingido,
  type ContadoresCiclo,
  type EntradaDecisaoVeredito,
  type LimitesCiclo,
} from './ciclos';
import { proximoEstado } from './maquina-execucao';
import { validarVeredito } from './regras-contratos';
import { similaridadeTrigramas, trigramas } from './texto';

/** Ciclos, limites e pingue-pongue (specs/forja/03 §6; 04 §6). */

const LIMITES: LimitesCiclo = { max_auto: 2, max_total: 5 };
const ZERO: ContadoresCiclo = { ciclo_auto: 0, ciclo_total: 0 };

describe('trigramas (pg_trgm)', () => {
  it('palavras com bordas, sem acento e sem caixa', () => {
    expect([...trigramas('Ação')].sort()).toEqual(['  a', ' ac', 'aca', 'cao', 'ao '].sort());
    expect(similaridadeTrigramas('Alteração', 'alteracao')).toBe(1);
    expect(similaridadeTrigramas('', '')).toBe(1);
    expect(similaridadeTrigramas('abc', '')).toBe(0);
  });

  it('reescrita leve fica ≥ 0,8; descrição diferente fica bem abaixo', () => {
    const a = 'a paginação ignora o último registro da página';
    expect(similaridadeTrigramas(a, 'a paginação ignora o último registro da página.')).toBe(1);
    expect(
      similaridadeTrigramas(a, 'a paginacao ignora o ultimo registro da pagina atual'),
    ).toBeGreaterThanOrEqual(0.8);
    expect(similaridadeTrigramas(a, 'falta validar o e-mail no cadastro')).toBeLessThan(0.3);
  });
});

describe('pingue-pongue (03 §6)', () => {
  it('(a) mesmo (categoria, arquivo) e descrição parecida em vereditos consecutivos', () => {
    const anterior = vereditoFalso({ achados: [achadoFalso({ id: 'A1' })] });
    const atual = vereditoFalso({
      achados: [
        achadoFalso({ id: 'A3', descricao: 'a paginação ignora o último registro da página.' }),
      ],
    });
    const pares = achadosRepetidos(anterior, atual);
    expect(pares).toHaveLength(1);
    expect(pares[0]).toMatchObject({ atual: 'A3', anterior: 'A1' });
  });

  it('(a) não repete: outro arquivo, outra categoria, sugestão, ou sem anterior', () => {
    const anterior = vereditoFalso({ achados: [achadoFalso()] });
    expect(
      achadosRepetidos(
        anterior,
        vereditoFalso({ achados: [achadoFalso({ arquivo: 'outro.ts' })] }),
      ),
    ).toEqual([]);
    expect(
      achadosRepetidos(anterior, vereditoFalso({ achados: [achadoFalso({ categoria: 'teste' })] })),
    ).toEqual([]);
    expect(
      achadosRepetidos(
        anterior,
        vereditoFalso({ achados: [achadoFalso({ severidade: 'sugestao' })] }),
      ),
    ).toEqual([]);
    expect(achadosRepetidos(null, vereditoFalso({ achados: [achadoFalso()] }))).toEqual([]);
    expect(
      achadosRepetidos(
        anterior,
        vereditoFalso({ achados: [achadoFalso({ descricao: 'faltou um teste de unidade' })] }),
      ),
    ).toEqual([]);
  });
});

describe('decidirAposVeredito (03 §2.4; 04 §6)', () => {
  const ctxVal = {
    sha_verificado: SHA_A,
    ids_criterios: ['CA1'],
    refs_validas: ['artefato:a1'],
    revisao_seguranca_obrigatoria: false,
  };
  function entrada(p: Partial<EntradaDecisaoVeredito> = {}): EntradaDecisaoVeredito {
    const veredito = p.veredito ?? vereditoFalso();
    return {
      veredito,
      validacao: validarVeredito(veredito, ctxVal),
      veredito_anterior: null,
      head_igual_sha_verificado: true,
      worktree_limpa: true,
      contadores: ZERO,
      limites: LIMITES,
      repeticoes_invalido: 0,
      recusas_feitas: 0,
      ...p,
    };
  }
  const reprovado = vereditoFalso({
    decisao: 'reprovado',
    recomendacao: 'retrabalhar',
    achados: [achadoFalso()],
  });

  it('aprovado limpo → relatando', () => {
    expect(decidirAposVeredito(entrada())).toMatchObject({
      acao: 'transicao',
      decisao: { para: 'relatando' },
      decisao_do_app: 'relatando',
    });
  });

  it('a revisão alterou a worktree → precisa_humano', () => {
    for (const p of [{ head_igual_sha_verificado: false }, { worktree_limpa: false }]) {
      expect(decidirAposVeredito(entrada(p))).toMatchObject({
        acao: 'transicao',
        decisao: { para: 'precisa_humano', motivo: 'regra_conteudo_violada' },
      });
    }
  });

  it('sha_avaliado errado → T2 de novo 1×, depois humano', () => {
    const v = vereditoFalso({ sha_avaliado: 'c'.repeat(40) });
    expect(
      decidirAposVeredito(entrada({ veredito: v, validacao: validarVeredito(v, ctxVal) })),
    ).toMatchObject({
      acao: 'repetir_t2',
    });
    expect(
      decidirAposVeredito(
        entrada({ veredito: v, validacao: validarVeredito(v, ctxVal), repeticoes_invalido: 1 }),
      ),
    ).toMatchObject({ acao: 'transicao', decisao: { para: 'precisa_humano' } });
  });

  it('regra violada → 1 recusa com instrução, depois humano', () => {
    const v = vereditoFalso({ criterios: [] });
    const val = validarVeredito(v, ctxVal);
    expect(decidirAposVeredito(entrada({ veredito: v, validacao: val }))).toMatchObject({
      acao: 'recusar',
    });
    expect(
      decidirAposVeredito(entrada({ veredito: v, validacao: val, recusas_feitas: 1 })),
    ).toMatchObject({ decisao: { para: 'precisa_humano', motivo: 'regra_conteudo_violada' } });
  });

  it('"aprovado" com bloqueante é tratado como reprovado e registra a incoerência', () => {
    const v = vereditoFalso({ achados: [achadoFalso()] });
    const r = decidirAposVeredito(entrada({ veredito: v, validacao: validarVeredito(v, ctxVal) }));
    expect(r).toMatchObject({ acao: 'transicao', decisao: { para: 'implementando' } });
    if (r.acao === 'transicao') expect(r.incoerencias.join()).toContain('bloqueante');
  });

  it('aprovado mas pede retrabalho → retrabalho; o nível ⚙ não entra na decisão (FJ-032)', () => {
    const v = vereditoFalso({ recomendacao: 'retrabalhar' });
    expect(
      decidirAposVeredito(entrada({ veredito: v, validacao: validarVeredito(v, ctxVal) })),
    ).toMatchObject({ decisao_do_app: 'retrabalho' });
    const semComandos = vereditoFalso({ comandos_executados: [] });
    expect(
      decidirAposVeredito(
        entrada({ veredito: semComandos, validacao: validarVeredito(semComandos, ctxVal) }),
      ),
    ).toMatchObject({ decisao_do_app: 'relatando' });
  });

  it('bloqueado ou escalar → relatando com aviso (FJ-035: o humano decide na aprovação)', () => {
    for (const v of [
      vereditoFalso({ decisao: 'bloqueado' }),
      vereditoFalso({ recomendacao: 'escalar' }),
    ]) {
      const d = decidirAposVeredito(
        entrada({ veredito: v, validacao: validarVeredito(v, ctxVal) }),
      );
      expect(d).toMatchObject({ decisao: { para: 'relatando' }, decisao_do_app: 'relatando' });
      expect(JSON.stringify(d)).toMatch(/revisão (não conseguiu|pediu)/);
    }
  });

  it('reprovado dentro dos limites → implementando; ciclo 1 reprova, ciclo 2 aprova (03 §12.2)', () => {
    expect(
      decidirAposVeredito(
        entrada({ veredito: reprovado, validacao: validarVeredito(reprovado, ctxVal) }),
      ),
    ).toMatchObject({ decisao: { para: 'implementando' }, decisao_do_app: 'retrabalho' });
    expect(
      decidirAposVeredito(
        entrada({
          veredito_anterior: reprovado,
          contadores: { ...ZERO, ciclo_auto: 1, ciclo_total: 1 },
        }),
      ),
    ).toMatchObject({ decisao: { para: 'relatando' } });
  });

  it('limites: max_auto → "revisão não convergiu"; max_total → "não está convergindo"', () => {
    const val = validarVeredito(reprovado, ctxVal);
    expect(
      decidirAposVeredito(
        entrada({
          veredito: reprovado,
          validacao: val,
          contadores: { ...ZERO, ciclo_auto: 2, ciclo_total: 2 },
        }),
      ),
    ).toMatchObject({ decisao: { motivo: 'ciclos_esgotados', texto: 'revisão não convergiu' } });
    expect(
      decidirAposVeredito(
        entrada({
          veredito: reprovado,
          validacao: val,
          contadores: { ...ZERO, ciclo_auto: 1, ciclo_total: 5 },
        }),
      ),
    ).toMatchObject({ decisao: { motivo: 'ciclos_esgotados', texto: 'não está convergindo' } });
  });

  it('achado repetido leva a precisa_humano ANTES do limite (03 §12.2)', () => {
    const r = decidirAposVeredito(
      entrada({
        veredito: reprovado,
        validacao: validarVeredito(reprovado, ctxVal),
        veredito_anterior: vereditoFalso({ achados: [achadoFalso({ id: 'A7' })] }),
        contadores: { ...ZERO, ciclo_auto: 1, ciclo_total: 1 },
      }),
    );
    expect(r).toMatchObject({
      decisao: { para: 'precisa_humano', motivo: 'pingue_pongue' },
      repetidos: ['A1'],
    });
  });

  it('toda transição devolvida é aceita pela máquina em revisando', () => {
    const casos = [
      entrada(),
      entrada({ veredito: reprovado, validacao: validarVeredito(reprovado, ctxVal) }),
      entrada({ worktree_limpa: false }),
    ];
    for (const c of casos) {
      const d = decidirAposVeredito(c);
      if (d.acao !== 'transicao') throw new Error('esperado transição');
      expect(
        proximoEstado(
          { estado: 'revisando', estado_anterior: null },
          { tipo: 'veredito_avaliado', decisao: d.decisao },
        ).tipo,
      ).toBe('transicao');
    }
  });
});

describe('recusa, saída inválida e demais limites (03 §6)', () => {
  it('recusa 1× com instrução; saída inválida 1 nova tentativa', () => {
    expect(decidirRecusa([], 0)).toEqual({ acao: 'aceitar' });
    expect(decidirRecusa(['x'], 0)).toEqual({ acao: 'recusar', erros: ['x'] });
    expect(decidirRecusa(['x'], 1)).toMatchObject({ acao: 'precisa_humano' });
    expect(decidirSaidaInvalida(0)).toEqual({ acao: 'repetir' });
    expect(decidirSaidaInvalida(1)).toEqual({ acao: 'falhou', motivo: 'saida_invalida' });
  });

  it('mais um ciclo acima do teto exige confirmação', () => {
    expect(maisUmCicloExigeConfirmacao({ ciclo_total: 4 }, LIMITES)).toBe(false);
    expect(maisUmCicloExigeConfirmacao({ ciclo_total: 5 }, LIMITES)).toBe(true);
  });

  it('teto por chamado em micro-USD', () => {
    expect(tetoPorChamadoAtingido(39_999_999, 40)).toBe(false);
    expect(tetoPorChamadoAtingido(40_000_000, 40)).toBe(true);
  });

  it('15 min sem evento = aviso', () => {
    const agora = new Date('2026-10-02T12:00:00Z');
    expect(semAtividade('2026-10-02T11:45:00Z', agora, 15)).toBe(true);
    expect(semAtividade('2026-10-02T11:46:00Z', agora, 15)).toBe(false);
    expect(semAtividade(null, agora, 15)).toBe(false);
  });
});
