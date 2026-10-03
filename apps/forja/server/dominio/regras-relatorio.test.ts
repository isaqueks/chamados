import { describe, expect, it } from 'vitest';
import { relatorioFalso } from './apoio-testes';
import { proximoEstado } from './maquina-execucao';
import {
  afirmaE2e,
  avaliarRelatorio,
  declaracaoSemPrints,
  decidirRelatorio,
  tipoRespostaExigido,
  type AvaliacaoRelatorio,
  type FatosRelatorio,
} from './regras-relatorio';

/** relatorio.v1: seções, selos × relatório, FJ-026, resposta (specs/forja/04 §6, §7.2, §8.2). */

const FATOS: FatosRelatorio = {
  selos: {
    altera_banco: false,
    altera_regra_negocio: false,
    altera_ui: false,
    sensivel: [],
    docs_exigidas_ok: null,
    dependencias_novas: [],
  },
  plano_altera_schema: false,
  ids_criterios: ['CA1'],
  nivel_verificacao: 'verificacao_estatica',
  evidencia_visual: 'nao_se_aplica',
  telas_fatos: [],
  telas_fotografadas: [],
  refs_validas: ['log:unit@aaaaaaaa'],
  versao: 1,
  tipo_resposta: 'aguardando_publicacao',
  validacao_resposta: { ok: true },
};

const comSelos = (p: Partial<FatosRelatorio['selos']>, f: Partial<FatosRelatorio> = {}) => ({
  ...FATOS,
  ...f,
  selos: { ...FATOS.selos, ...p },
});

const ITEM_BANCO = {
  em_linguagem_simples: 'novo campo de limite',
  objeto_tecnico: 'clientes.limite',
  tipo: 'coluna_nova' as const,
  afeta_dados_existentes: false,
  reversivel: true,
};
const TELA = { tela_id: 'UI1', o_que_mudou_para_quem_usa: 'aparece um aviso abaixo do e-mail' };

describe('avaliarRelatorio — caso feliz', () => {
  it('sem recusas, incoerências, avisos ou alertas', () => {
    expect(avaliarRelatorio(relatorioFalso(), FATOS)).toEqual({
      recusas: [],
      incoerencias: [],
      incoerencias_resposta: [],
      avisos: [],
      alertas_g2: [],
    });
  });
});

describe('seções obrigatórias e coerência interna → recusa (04 §6)', () => {
  it('houve ⇔ itens', () => {
    const r = avaliarRelatorio(
      relatorioFalso({
        regras_de_negocio_alteradas: { houve: true, itens: [], declaracao: 'x' },
        alteracoes_no_schema_do_banco: {
          houve: false,
          itens: [ITEM_BANCO],
          declaracao: 'x',
          exige_migracao_no_deploy: false,
        },
      }),
      FATOS,
    );
    expect(r.recusas).toEqual([
      'regras_de_negocio_alteradas: houve = true sem itens',
      'alteracoes_no_schema_do_banco: houve = false com itens',
    ]);
  });

  it('interface: houve sem telas só com sem_evidencia_visual e nenhuma tela nos fatos', () => {
    const rel = relatorioFalso({
      alteracoes_de_interface: { houve: true, telas: [], declaracao: 'x' },
    });
    expect(avaliarRelatorio(rel, FATOS).recusas).toEqual([
      'alteracoes_de_interface: houve = true sem telas',
    ]);
    expect(
      avaliarRelatorio(rel, { ...FATOS, evidencia_visual: 'sem_evidencia_visual' }).recusas,
    ).toEqual([]);
    expect(
      avaliarRelatorio(rel, {
        ...FATOS,
        evidencia_visual: 'sem_evidencia_visual',
        telas_fatos: ['UI1'],
      }).recusas,
    ).toHaveLength(1);
  });

  it('tela fora dos fatos do app é recusada', () => {
    const r = avaliarRelatorio(
      relatorioFalso({ alteracoes_de_interface: { houve: true, telas: [TELA], declaracao: 'x' } }),
      FATOS,
    );
    expect(r.recusas).toEqual(['alteracoes_de_interface: tela UI1 não está nos fatos do app']);
  });

  it('cenários cobrem os CA; "ok" exige ref válida', () => {
    const r = avaliarRelatorio(
      relatorioFalso({
        como_foi_testado: {
          cenarios: [
            { criterio: 'CA2', resultado: 'ok', evidencia_ref: 'artefato:zzz' },
            { criterio: 'CA3', resultado: 'nao_testado', evidencia_ref: null },
          ],
        },
      }),
      { ...FATOS, ids_criterios: ['CA1', 'CA2'] },
    );
    expect(r.recusas).toEqual([
      'como_foi_testado: critério CA1 sem cenário',
      'como_foi_testado: critério CA3 não existe no plano',
      'como_foi_testado: CA2 "ok" exige evidencia_ref válida',
    ]);
  });

  it('versão 2 exige "mudou desde a última versão"', () => {
    expect(avaliarRelatorio(relatorioFalso(), { ...FATOS, versao: 2 }).recusas).toEqual([
      'versão 2 em diante exige mudou_desde_a_ultima_versao',
    ]);
    expect(
      avaliarRelatorio(relatorioFalso({ mudou_desde_a_ultima_versao: ['aceita +tag'] }), {
        ...FATOS,
        versao: 2,
      }).recusas,
    ).toEqual([]);
  });
});

describe('nível × texto (04 §6)', () => {
  it('afirmaE2e ignora a negação correta de U-7', () => {
    expect(afirmaE2e('Testado ponta a ponta no cadastro')).toBe(true);
    expect(afirmaE2e('validado com E2E')).toBe(true);
    expect(afirmaE2e('testado no navegador')).toBe(true);
    expect(afirmaE2e('CA3 não testado ponta a ponta (o projeto não tem e2e)')).toBe(false);
    expect(afirmaE2e('sem teste e2e')).toBe(false);
    expect(afirmaE2e('paginação melhorada')).toBe(false);
  });

  it('afirmar e2e sem nível e2e é incoerência; com e2e_automatizado não', () => {
    const rel = relatorioFalso({ resumo: 'Corrigido e testado ponta a ponta.' });
    expect(avaliarRelatorio(rel, FATOS).incoerencias).toHaveLength(1);
    expect(
      avaliarRelatorio(rel, { ...FATOS, nivel_verificacao: 'e2e_automatizado' }).incoerencias,
    ).toEqual([]);
  });
});

describe('selos × relatório (04 §7.2)', () => {
  it('altera_banco sem declarar → incoerência; declarar sem selo → aviso amarelo', () => {
    expect(
      avaliarRelatorio(relatorioFalso(), comSelos({ altera_banco: true })).incoerencias,
    ).toEqual(['o diff altera o banco e o relatório diz que não há alteração no schema']);
    const declarado = relatorioFalso({
      alteracoes_no_schema_do_banco: {
        houve: true,
        itens: [ITEM_BANCO],
        declaracao: 'x',
        exige_migracao_no_deploy: true,
      },
    });
    const r = avaliarRelatorio(declarado, FATOS);
    expect(r.incoerencias).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(['banco_declarado_nao_detectado']);
  });

  it('altera_regra_negocio sem declarar → incoerência', () => {
    expect(
      avaliarRelatorio(relatorioFalso(), comSelos({ altera_regra_negocio: true })).incoerencias,
    ).toHaveLength(1);
  });

  it('dependências novas ausentes → incoerência (palavra inteira, sem caixa)', () => {
    const f = comSelos({ dependencias_novas: ['zod', '@scope/pkg'] });
    expect(avaliarRelatorio(relatorioFalso(), f).incoerencias).toEqual([
      'dependências novas ausentes do relatório: zod, @scope/pkg',
    ]);
    expect(
      avaliarRelatorio(
        relatorioFalso({ dependencias_novas: ['Zod (validação)', '@scope/pkg para datas'] }),
        f,
      ).incoerencias,
    ).toEqual([]);
    expect(
      avaliarRelatorio(
        relatorioFalso({ dependencias_novas: ['zodiac'] }),
        comSelos({ dependencias_novas: ['zod'] }),
      ).incoerencias,
    ).toHaveLength(1);
  });

  it('schema fora do plano e docs exigidas → alertas vermelhos no G2 (não bloqueiam)', () => {
    const declarado = relatorioFalso({
      alteracoes_no_schema_do_banco: {
        houve: true,
        itens: [ITEM_BANCO],
        declaracao: 'x',
        exige_migracao_no_deploy: true,
      },
    });
    const r = avaliarRelatorio(
      declarado,
      comSelos({ altera_banco: true, docs_exigidas_ok: false }),
    );
    expect(r.incoerencias).toEqual([]);
    expect(r.alertas_g2.map((a) => a.codigo)).toEqual(['schema_fora_do_plano', 'docs_exigidas']);
    expect(
      avaliarRelatorio(declarado, comSelos({ altera_banco: true }, { plano_altera_schema: true }))
        .alertas_g2,
    ).toEqual([]);
  });
});

describe('FJ-026: altera_ui × alteracoes_de_interface (04 §7.2)', () => {
  const ui = (p: Partial<FatosRelatorio> = {}) =>
    comSelos({ altera_ui: true }, { telas_fatos: ['UI1', 'UI2'], ...p });

  it('prints completos: houve = false → incoerência', () => {
    const r = avaliarRelatorio(
      relatorioFalso(),
      ui({ evidencia_visual: 'completa', telas_fotografadas: ['UI1'] }),
    );
    expect(r.incoerencias).toEqual([
      'telas fotografadas, mas o relatório diz que a interface não mudou',
    ]);
  });

  it('prints completos: tela fotografada ausente de telas → incoerência', () => {
    const r = avaliarRelatorio(
      relatorioFalso({ alteracoes_de_interface: { houve: true, telas: [TELA], declaracao: 'x' } }),
      ui({ evidencia_visual: 'completa', telas_fotografadas: ['UI1', 'UI2'] }),
    );
    expect(r.incoerencias).toEqual(['telas fotografadas ausentes do relatório: UI2']);
  });

  it('prints completos e todas as telas → coerente', () => {
    expect(
      avaliarRelatorio(
        relatorioFalso({
          alteracoes_de_interface: { houve: true, telas: [TELA], declaracao: 'uma tela mudou' },
        }),
        ui({ evidencia_visual: 'completa', telas_fotografadas: ['UI1'] }),
      ),
    ).toMatchObject({ recusas: [], incoerencias: [], avisos: [] });
  });

  it('sem prints (parcial/sem): declaração sem o texto → incoerência; com o texto → coerente + faixa', () => {
    for (const ev of ['parcial', 'sem_evidencia_visual'] as const) {
      const semTexto = avaliarRelatorio(
        relatorioFalso({
          alteracoes_de_interface: { houve: true, telas: [TELA], declaracao: 'mudou o aviso' },
        }),
        ui({ evidencia_visual: ev }),
      );
      expect(semTexto.incoerencias).toEqual([
        'a declaração de interface deve trazer "alteração de interface sem prints: <motivo>"',
      ]);
      const comTexto = avaliarRelatorio(
        relatorioFalso({
          alteracoes_de_interface: {
            houve: true,
            telas: [TELA],
            declaracao: declaracaoSemPrints('o app não subiu: healthcheck estourou 90 s'),
          },
        }),
        ui({ evidencia_visual: ev }),
      );
      expect(comTexto.incoerencias).toEqual([]);
      expect(comTexto.avisos.map((a) => a.codigo)).toEqual(['evidencia_visual_incompleta']);
    }
  });

  it('o texto "sem prints" tolera acento/caixa, mas exige o motivo', () => {
    const f = ui({ evidencia_visual: 'sem_evidencia_visual' });
    const com = (declaracao: string) =>
      avaliarRelatorio(
        relatorioFalso({ alteracoes_de_interface: { houve: true, telas: [TELA], declaracao } }),
        f,
      ).incoerencias;
    expect(com('Alteracao de interface sem prints: login expirou')).toEqual([]);
    expect(com('Alteração de interface sem prints:')).toHaveLength(1);
  });

  it('caso "sem prints" sem nenhuma tela declarada: houve = true e telas vazias é aceito', () => {
    const r = avaliarRelatorio(
      relatorioFalso({
        alteracoes_de_interface: {
          houve: true,
          telas: [],
          declaracao: declaracaoSemPrints('app_subir não configurado'),
        },
      }),
      comSelos({ altera_ui: true }, { evidencia_visual: 'sem_evidencia_visual' }),
    );
    expect(r.recusas).toEqual([]);
    expect(r.incoerencias).toEqual([]);
  });

  it('altera_ui = false com houve = true → aviso amarelo', () => {
    const r = avaliarRelatorio(
      relatorioFalso({ alteracoes_de_interface: { houve: true, telas: [TELA], declaracao: 'x' } }),
      { ...FATOS, telas_fatos: ['UI1'] },
    );
    expect(r.incoerencias).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(['ui_declarada_nao_detectada']);
  });
});

describe('resposta ao cliente (04 §6, §8.2)', () => {
  it('tipo diferente do exigido e validador reprovado → incoerências da resposta', () => {
    const r = avaliarRelatorio(
      relatorioFalso({
        resposta_ao_cliente: {
          versao: 1,
          tipo: 'disponivel',
          corpo_markdown: 'Fizemos o merge.',
          cita_prazo: false,
        },
      }),
      { ...FATOS, validacao_resposta: { ok: false, motivos: [{ chave: 'lexico:merge' }] } },
    );
    expect(r.incoerencias).toEqual([]);
    expect(r.incoerencias_resposta).toEqual([
      'resposta_ao_cliente.tipo "disponivel" ≠ exigido "aguardando_publicacao"',
      'a resposta ao cliente não passou no validador de linguagem: lexico:merge',
    ]);
  });

  it('tipoRespostaExigido', () => {
    const base = { merge_publica: false, ao_concluir: 'resolvido' as const };
    expect(tipoRespostaExigido({ ...base, momento: 'gdec' })).toBe('pergunta');
    expect(tipoRespostaExigido({ ...base, momento: 'conclusao' })).toBe('aguardando_publicacao');
    expect(tipoRespostaExigido({ ...base, momento: 'conclusao', merge_publica: true })).toBe(
      'disponivel',
    );
    expect(
      tipoRespostaExigido({ ...base, momento: 'conclusao', ao_concluir: 'aguardar_deploy' }),
    ).toBe('disponivel');
  });
});

describe('decidirRelatorio — recusar, regerar 1×, alertar (04 §6, §7.2)', () => {
  const vazio: AvaliacaoRelatorio = {
    recusas: [],
    incoerencias: [],
    incoerencias_resposta: [],
    avisos: [],
    alertas_g2: [],
  };
  const zero = { recusas_feitas: 0, regeneracoes_feitas: 0 };

  it('coerente → aguardando_aprovacao', () => {
    expect(decidirRelatorio(vazio, zero)).toEqual({
      acao: 'transicao',
      decisao: { para: 'aguardando_aprovacao' },
      resposta_marcada_para_g2: false,
      incoerencias: [],
    });
  });

  it('recusa 1×, depois precisa_humano regra_conteudo_violada', () => {
    const a = { ...vazio, recusas: ['x'] };
    expect(decidirRelatorio(a, zero)).toEqual({ acao: 'recusar', erros: ['x'] });
    expect(decidirRelatorio(a, { ...zero, recusas_feitas: 1 })).toMatchObject({
      decisao: { para: 'precisa_humano', motivo: 'regra_conteudo_violada' },
    });
  });

  it('incoerência com selos: regera 1×, depois segue ao G2 com aviso (FJ-034)', () => {
    const a = { ...vazio, incoerencias: ['contradiz'] };
    expect(decidirRelatorio(a, zero)).toEqual({ acao: 'regerar', apontamentos: ['contradiz'] });
    const d = decidirRelatorio(a, { ...zero, regeneracoes_feitas: 1 });
    expect(d).toMatchObject({
      acao: 'transicao',
      decisao: { para: 'aguardando_aprovacao' },
      incoerencias: ['contradiz'],
    });
  });

  it('só a resposta: regera 1×; persistindo vai ao G2 marcada para edição', () => {
    const a = { ...vazio, incoerencias_resposta: ['tipo'] };
    expect(decidirRelatorio(a, zero).acao).toBe('regerar');
    expect(decidirRelatorio(a, { ...zero, regeneracoes_feitas: 1 })).toMatchObject({
      decisao: { para: 'aguardando_aprovacao' },
      resposta_marcada_para_g2: true,
    });
  });

  it('as transições devolvidas são aceitas pela máquina em relatando', () => {
    for (const a of [vazio, { ...vazio, incoerencias: ['x'] }, { ...vazio, recusas: ['y'] }]) {
      const d = decidirRelatorio(a, { recusas_feitas: 1, regeneracoes_feitas: 1 });
      if (d.acao !== 'transicao') throw new Error('esperado transição');
      expect(
        proximoEstado(
          { estado: 'relatando', estado_anterior: null },
          { tipo: 'relatorio_avaliado', decisao: d.decisao },
        ).tipo,
      ).toBe('transicao');
    }
  });
});
