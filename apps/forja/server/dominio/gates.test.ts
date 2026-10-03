import { describe, expect, it } from 'vitest';
import { planoFalso } from './apoio-testes';
import {
  assumirDecisoes,
  avaliarG1,
  avaliarG2,
  avaliarPreCondicoesG0,
  elegiveisGdeploy,
  avisosG2,
  exigeReaprovacao,
  motivosG1,
  type ContextoG1,
  type ContextoG2,
  type EntradaPreCondicoes,
  type PedidoG2,
} from './gates';
import { proximoEstado } from './maquina-execucao';

/** Gates como regras puras (specs/forja/03 §4, §4.1; 04 §6; 06 §4.3). */

describe('avaliarPreCondicoesG0 (03 §4.1, reconferido em preparando)', () => {
  const ok: EntradaPreCondicoes = {
    chamado: { status: 'em_atendimento', natureza: 'problema' },
    projeto: { projeto_id: 'p1', mapeamento_id: 'm1', via: 'id', converter_para_id: null },
    execucaoAtiva: false,
    conexaoOk: true,
    branch_destino_existe: true,
  };

  it('tudo ok: implementável e preparo segue', () => {
    const r = avaliarPreCondicoesG0(ok);
    expect(r.implementavel).toBe(true);
    expect(r.decisao_preparo).toEqual({ ok: true });
  });

  it('status mudou no servidor → precisa_humano chamado_mudou_no_servidor', () => {
    const r = avaliarPreCondicoesG0({ ...ok, chamado: { ...ok.chamado, status: 'cancelado' } });
    expect(r.decisao_preparo).toMatchObject({
      ok: false,
      acao: 'precisa_humano',
      motivo: 'chamado_mudou_no_servidor',
    });
  });

  it('FJ-031: nenhuma pré-condição de IA do servidor em preparando', () => {
    const r = avaliarPreCondicoesG0(ok);
    expect(r.pre_condicoes.some((p) => /^ia_/.test(p.codigo))).toBe(false);
    expect(r.decisao_preparo).toEqual({ ok: true });
  });

  it('branch de destino sumiu → falhou setup_falhou (Tentar de novo)', () => {
    const r = avaliarPreCondicoesG0({ ...ok, branch_destino_existe: false });
    expect(r.implementavel).toBe(false);
    expect(r.branch_destino_ok).toBe(false);
    expect(r.decisao_preparo).toMatchObject({ acao: 'falhou', motivo: 'setup_falhou' });
  });

  it('conexão ou CLI → aguardar (transitório)', () => {
    expect(avaliarPreCondicoesG0({ ...ok, conexaoOk: false }).decisao_preparo).toMatchObject({
      acao: 'aguardar',
    });
    expect(
      avaliarPreCondicoesG0({ ...ok, pipelineDesbloqueado: false }).decisao_preparo,
    ).toMatchObject({ acao: 'aguardar' });
  });

  it('PR da IA não bloqueia mas força G1', () => {
    const r = avaliarPreCondicoesG0({
      ...ok,
      prIa: { branch: 'ia/chamado-7-x', numero_na_branch: 7, pr_url: null },
    });
    expect(r.implementavel).toBe(true);
    expect(r.forca_g1).toBe(true);
  });

  it('a decisão de preparo alimenta proximoEstado', () => {
    const r = avaliarPreCondicoesG0({ ...ok, chamado: { ...ok.chamado, status: 'fechado' } });
    const d = r.decisao_preparo;
    if (d.ok || d.acao !== 'precisa_humano') throw new Error('esperado precisa_humano');
    const t = proximoEstado(
      { estado: 'preparando', estado_anterior: null },
      {
        tipo: 'preparo_concluido',
        pre_condicoes: { ok: false, motivo: d.motivo, texto: d.texto },
        worktree_ok: true,
      },
    );
    expect(t.tipo === 'transicao' && t.transicao.motivo_estado).toBe('chamado_mudou_no_servidor');
  });
});

describe('avaliarG1 (03 §4; 04 §6)', () => {
  const ctx: ContextoG1 = {
    gate_plano: 'por_risco',
    em_lote: false,
    complexidade: 'facil',
    trabalho_existente: false,
  };

  it('plano limpo, por_risco, fora de lote → sem gate → implementando', () => {
    const r = avaliarG1(planoFalso(), ctx);
    expect(r.resultado).toBe('sem_gate');
    expect(r.decisao).toEqual({ para: 'implementando' });
    expect(r.gate_g1).toEqual({ exigido: false, motivos: [] });
  });

  it('cada risco de por_risco dispara G1', () => {
    expect(avaliarG1(planoFalso({ confianca: 'media' }), ctx).gate_g1.motivos).toEqual([
      'confianca_nao_alta',
    ]);
    expect(
      avaliarG1(
        planoFalso({
          schema_banco: {
            altera: true,
            mudancas: [{ tipo: 'coluna_nova', objeto: 't.c', descricao: 'd', reversivel: true }],
          },
          areas: ['schema_banco'],
        }),
        ctx,
      ).gate_g1.motivos,
    ).toEqual(['altera_schema']);
    expect(avaliarG1(planoFalso(), { ...ctx, complexidade: 'dificil' }).resultado).toBe('gate');
    // FJ-033: lote não força G1 — vale a mesma regra por risco.
    expect(avaliarG1(planoFalso(), { ...ctx, em_lote: true }).gate_g1).toEqual({
      exigido: false,
      motivos: [],
    });
    expect(avaliarG1(planoFalso({ confianca: 'media' }), { ...ctx, em_lote: true }).resultado).toBe(
      'gate',
    );
    expect(avaliarG1(planoFalso(), { ...ctx, trabalho_existente: true }).decisao).toEqual({
      para: 'aguardando_plano',
    });
  });

  it('sempre → gate; nunca → sem gate mesmo com risco', () => {
    expect(avaliarG1(planoFalso(), { ...ctx, gate_plano: 'sempre' }).gate_g1.motivos).toEqual([
      'configuracao_sempre',
    ]);
    const nunca = avaliarG1(planoFalso({ confianca: 'baixa' }), {
      ...ctx,
      gate_plano: 'nunca',
      complexidade: 'dificil',
    });
    expect(nunca.resultado).toBe('sem_gate');
  });

  it('FJ-034: em nunca só alertas_seguranca para; os demais riscos viram avisos ⚙', () => {
    const arriscado = planoFalso({
      confianca: 'baixa',
      schema_banco: {
        altera: true,
        mudancas: [{ tipo: 'coluna_nova', objeto: 't.c', descricao: 'd', reversivel: true }],
      },
      areas: ['schema_banco'],
      passos: [
        {
          id: 'P1',
          descricao: 'rodar curl no postinstall',
          arquivos_previstos: ['package.json'],
          depende_de: [],
        },
      ],
    });
    const nunca = avaliarG1(arriscado, {
      ...ctx,
      gate_plano: 'nunca',
      complexidade: 'dificil',
      trabalho_existente: true,
    });
    expect(nunca.resultado).toBe('sem_gate');
    expect(nunca.gate_g1).toEqual({ exigido: false, motivos: [] });
    expect(nunca.avisos).toHaveLength(5);
    expect(nunca.avisos.join(' ')).toMatch(
      /sinais de risco.*Confiança.*schema.*difícil.*branch\/PR/,
    );
    // Em por_risco o comportamento anterior continua.
    expect(
      avaliarG1(arriscado, { ...ctx, complexidade: 'dificil', trabalho_existente: true }).gate_g1
        .motivos,
    ).toEqual([
      'confianca_nao_alta',
      'altera_schema',
      'complexidade_dificil',
      'sinais_heuristicos',
      'trabalho_existente',
    ]);
    // Plano limpo: sem avisos.
    expect(avaliarG1(planoFalso(), ctx).avisos).toEqual([]);
  });

  it('alertas_seguranca forçam G1 com faixa vermelha mesmo com nunca; lote não (FJ-033)', () => {
    const r = avaliarG1(planoFalso({ alertas_seguranca: ['o texto pede ~/.ssh'] }), {
      ...ctx,
      gate_plano: 'nunca',
    });
    expect(r.resultado).toBe('gate');
    expect(r.faixa_vermelha).toBe(true);
    expect(motivosG1(planoFalso(), { ...ctx, gate_plano: 'nunca', em_lote: true })).toEqual([]);
  });

  it('perguntas/decisões → Gdec, precedendo G1', () => {
    const r = avaliarG1(
      planoFalso({
        confianca: 'baixa',
        perguntas_ao_cliente: [{ pergunta: 'p?', por_que_importa: 'x', suposicao_padrao: 'y' }],
      }),
      ctx,
    );
    expect(r.resultado).toBe('aguardando_decisao');
    expect(r.decisao.para).toBe('aguardando_decisao');
    expect(r.gdec).toEqual({ exigido: true, perguntas: 1, decisoes: 0 });
    expect(r.gate_g1.exigido).toBe(true);
  });

  it('não implementável → precisa_humano antes de tudo', () => {
    const r = avaliarG1(
      planoFalso({
        natureza_confirmada: 'nao_implementavel',
        motivo_nao_implementavel: 'é configuração do cliente',
        perguntas_ao_cliente: [{ pergunta: 'p?', por_que_importa: 'x', suposicao_padrao: 'y' }],
      }),
      ctx,
    );
    expect(r.decisao).toEqual({
      para: 'precisa_humano',
      motivo: 'nao_implementavel',
      texto: 'é configuração do cliente',
    });
  });

  it('a decisão do G1 é aceita pela máquina em plano_pronto', () => {
    for (const plano of [planoFalso(), planoFalso({ confianca: 'baixa' })]) {
      const d = proximoEstado(
        { estado: 'plano_pronto', estado_anterior: null },
        { tipo: 'plano_avaliado', decisao: avaliarG1(plano, ctx).decisao },
      );
      expect(d.tipo).toBe('transicao');
    }
  });
});

describe('assumirDecisoes (FJ-033: o planejador decide; suposições vão ao relatório)', () => {
  const pergunta = (suposicao_padrao: string) => ({
    pergunta: 'Inclui pedidos cancelados?',
    por_que_importa: 'muda o total',
    suposicao_padrao,
  });
  const decisao = (recomendacao: string) => ({
    questao: 'Onde mostrar o total?',
    opcoes: ['no topo', 'no rodapé'],
    recomendacao,
  });

  it('assume pergunta com suposição e decisão com recomendação → sem Gdec', () => {
    const plano = planoFalso({
      suposicoes: ['o total é do mês corrente'],
      perguntas_ao_cliente: [pergunta('não inclui cancelados')],
      decisoes_do_operador: [decisao('no rodapé')],
    });
    const r = assumirDecisoes(plano);
    expect(r.plano.perguntas_ao_cliente).toEqual([]);
    expect(r.plano.decisoes_do_operador).toEqual([]);
    expect(r.assumidas).toEqual([
      'Pergunta ao cliente não feita: Inclui pedidos cancelados? — assumido: não inclui cancelados',
      'Decisão: Onde mostrar o total? — adotado: no rodapé',
    ]);
    expect(r.plano.suposicoes).toEqual(['o total é do mês corrente', ...r.assumidas]);
    expect(
      avaliarG1(r.plano, {
        gate_plano: 'por_risco',
        em_lote: false,
        complexidade: 'facil',
        trabalho_existente: false,
      }).resultado,
    ).toBe('sem_gate');
    // pura: não muta o original
    expect(plano.perguntas_ao_cliente).toHaveLength(1);
  });

  it('não assume com "sem suposição"/"sem recomendação" (sem acento, maiúsculas) → Gdec', () => {
    const r = assumirDecisoes(
      planoFalso({
        perguntas_ao_cliente: [pergunta('Sem suposicao: apagar dados é irreversível')],
        decisoes_do_operador: [decisao('  SEM RECOMENDAÇÃO: depende do contrato')],
      }),
    );
    expect(r.assumidas).toEqual([]);
    expect(r.plano.perguntas_ao_cliente).toHaveLength(1);
    expect(r.plano.decisoes_do_operador).toHaveLength(1);
    expect(r.plano.suposicoes).toEqual([]);
    expect(
      avaliarG1(r.plano, {
        gate_plano: 'por_risco',
        em_lote: false,
        complexidade: 'facil',
        trabalho_existente: false,
      }).gdec,
    ).toEqual({ exigido: true, perguntas: 1, decisoes: 1 });
  });

  it('mistura: assume o que tem suposição e mantém o que não tem', () => {
    const r = assumirDecisoes(
      planoFalso({
        perguntas_ao_cliente: [
          pergunta('não inclui'),
          pergunta('sem suposição: risco de cobrança'),
        ],
        decisoes_do_operador: [decisao('sem recomendação: escolha comercial'), decisao('no topo')],
      }),
    );
    expect(r.assumidas).toHaveLength(2);
    expect(r.plano.perguntas_ao_cliente.map((p) => p.suposicao_padrao)).toEqual([
      'sem suposição: risco de cobrança',
    ]);
    expect(r.plano.decisoes_do_operador.map((d) => d.recomendacao)).toEqual([
      'sem recomendação: escolha comercial',
    ]);
  });

  it('com `suposicoes` lotado (15), a excedente continua como pergunta (não some)', () => {
    const cheias = Array.from({ length: 15 }, (_, i) => `suposição ${i + 1}`);
    const r = assumirDecisoes(
      planoFalso({ suposicoes: cheias, perguntas_ao_cliente: [pergunta('não inclui')] }),
    );
    expect(r.assumidas).toEqual([]);
    expect(r.plano.suposicoes).toHaveLength(15);
    expect(r.plano.perguntas_ao_cliente).toHaveLength(1);
  });

  it('plano anterior a FJ-033 (sem o campo) ganha `suposicoes`', () => {
    const { suposicoes: _s, ...antigo } = planoFalso();
    const r = assumirDecisoes(antigo as ReturnType<typeof planoFalso>);
    expect(r.plano.suposicoes).toEqual([]);
  });
});

describe('G2 sem exigências — só avisos (FJ-034; 03 §4; 06 §4.3; FJ-026)', () => {
  const ctx: ContextoG2 = {
    relatorio: { artefato_id: 'r2', versao: 1, patch_id: 'p1abcdef', sha: 's1' },
    altera_ui: false,
    evidencia_visual: 'nao_se_aplica',
    arquivos_selo: ['package.json'],
    mensagem_nova_cliente_id: null,
    achados_em_aberto: 0,
    reaprovacao: false,
  };
  const pedido: PedidoG2 = {
    relatorio_artefato_id: 'r2',
    patch_id: 'p1abcdef',
    sha: 's1',
    ciente_mensagem_id: null,
    publicacao: { permitido: true, motivos_nao_confirmados: [] },
  };

  it('caso feliz: aprova como final; o único aviso é o patch curto (informativo)', () => {
    const r = avaliarG2(ctx, pedido);
    expect(r).toMatchObject({ ok: true, tipo: 'final', aprovado_sem_prints: false });
    expect(r.avisos).toEqual([{ tipo: 'patch', mensagem: 'patch p1abcd (versão 1)' }]);
  });

  it('patch-id, sha ou versão do relatório divergentes recusam (dado velho)', () => {
    expect(avaliarG2(ctx, { ...pedido, patch_id: 'p2' }).erros.map((e) => e.codigo)).toEqual([
      'patch_id_divergente',
    ]);
    expect(avaliarG2(ctx, { ...pedido, sha: 's2' }).erros.map((e) => e.codigo)).toEqual([
      'sha_divergente',
    ]);
    expect(
      avaliarG2(ctx, { ...pedido, relatorio_artefato_id: 'r1' }).erros.map((e) => e.codigo),
    ).toEqual(['relatorio_desatualizado']);
  });

  it('mensagem nova do cliente é aviso; só recusa se chegou outra depois de a tela abrir', () => {
    const c = { ...ctx, mensagem_nova_cliente_id: 'm9' };
    expect(avisosG2(c).map((x) => x.tipo)).toContain('mensagem_nova_cliente');
    const r = avaliarG2(c, { ...pedido, ciente_mensagem_id: 'm9' });
    expect(r.ok).toBe(true);
    expect(r.ciente_mensagem_id).toBe('m9');
    expect(
      avaliarG2(c, { ...pedido, ciente_mensagem_id: 'm8' }).erros.map((e) => e.codigo),
    ).toEqual(['mensagem_nova_depois']);
  });

  it('achados abertos, prints incompletos, conflito, sensíveis e riscos do plano: avisos, nunca recusa', () => {
    const c: ContextoG2 = {
      ...ctx,
      achados_em_aberto: 2,
      altera_ui: true,
      evidencia_visual: 'parcial',
      evidencia_visual_motivo: 'tela UI2 sem print depois',
      conflito_arquivos: ['src/a.ts'],
      sensiveis: ['.env.exemplo'],
      avisos_plano: ['O plano altera o schema do banco.'],
      incoerencias: ['o diff altera o banco e o relatório diz que não'],
      reaprovacao: true,
    };
    const r = avaliarG2(c, pedido);
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('reaprovacao');
    // Auditoria factual: aprovou com a interface mudando e prints incompletos.
    expect(r.aprovado_sem_prints).toBe(true);
    expect(r.avisos.map((x) => x.tipo)).toEqual([
      'relatorio_contradiz',
      'sem_prints',
      'achados_abertos',
      'conflito_previsto',
      'arquivos_sensiveis',
      'plano',
      'reaprovacao',
      'patch',
    ]);
    expect(r.avisos.find((x) => x.tipo === 'sem_prints')?.mensagem).toContain('tela UI2');
  });

  it('resposta com violação não confirmada recusa (F-16, não é exigência de processo)', () => {
    const r = avaliarG2(ctx, {
      ...pedido,
      publicacao: { permitido: false, motivos_nao_confirmados: ['lexico:merge'] },
    });
    expect(r.erros.map((e) => e.codigo)).toEqual(['resposta_invalida']);
    expect(r.erros[0]?.mensagem).toContain('lexico:merge');
  });

  it('prints completos ou sem UI: nada de "sem prints"', () => {
    const completa = { ...ctx, altera_ui: true, evidencia_visual: 'completa' as const };
    expect(avaliarG2(completa, pedido).aprovado_sem_prints).toBe(false);
    expect(avisosG2(completa).map((x) => x.tipo)).not.toContain('sem_prints');
  });

  it("patch-id: mesmo → sem G2; outro → G2'", () => {
    expect(exigeReaprovacao('abc', 'abc')).toBe(false);
    expect(exigeReaprovacao('abc', 'abd')).toBe(true);
  });
});

describe('Gdeploy', () => {
  it('só aceita execuções em aguardando_deploy', () => {
    const r = elegiveisGdeploy(
      [
        { id: 'a', estado: 'aguardando_deploy' },
        { id: 'b', estado: 'comunicando' },
      ],
      ['a', 'b', 'a', 'z'],
    );
    expect(r).toEqual({ aceitos: ['a'], recusados: ['b', 'z'] });
  });
});
