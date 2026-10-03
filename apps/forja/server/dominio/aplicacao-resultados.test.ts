import { describe, expect, it, vi } from 'vitest';

// Git real + SQLite: o default de 5 s estoura por carga da suíte inteira, não por defeito.
vi.setConfig({ testTimeout: 60_000 });
import type { ClassificacaoProcesso } from '../../comum/estados';
import type { Etapa } from '../db/entidades/etapa';
import {
  acoesDisponiveis,
  desfechoDaClassificacao,
  estadoEtapaDaClassificacao,
  etapaParaRetomar,
  maisUmCicloPermitido,
  paresTelas,
  retomadasAutomaticas,
  seguirComAchadosPermitido,
  somarNumstat,
  suposicoesDoRelatorio,
  telasDaExecucao,
  textoComandosDoStream,
  textoComoFoiVerificado,
  type ContextoAcoes,
} from './aplicacao-resultados';

/** Mapeamento classificação → fato (01 §6.6 × 03 §2.3/§6/§11) e contadores (03 §6). */

const ctx = {
  tentativasSaidaInvalida: 0,
  agentesForaDoPapel: 0,
  perfilJaReiniciado: false,
  paradaPedida: false,
};

function etapa(p: Partial<Etapa>): Etapa {
  return {
    id: Math.random().toString(16),
    execucao_id: 'e',
    n: 1,
    ciclo: 1,
    tipo: 'implementar',
    papel: null,
    estado: 'concluida',
    motivo_fim: 'concluido',
    contrato: null,
    session_id: 's',
    retomada: false,
    pid: null,
    pgid: null,
    modelo: null,
    esforco: null,
    prompt_versao: null,
    perfil: null,
    versao_cli: null,
    init: null,
    inicio: '2026-10-02T12:00:00.000Z',
    fim: null,
    ultimo_evento_em: null,
    exit_code: null,
    sinal: null,
    custo_micro_usd: null,
    model_usage: null,
    subagent_stats: null,
    permission_denials: null,
    condutor_editou: false,
    sha_inicio: null,
    sha_fim: null,
    comandos: null,
    telas: null,
    transcript_path: null,
    criado_em: '2026-10-02T12:00:00.000Z',
    atualizado_em: '2026-10-02T12:00:00.000Z',
    ...p,
  };
}

describe('desfechoDaClassificacao', () => {
  it.each<[ClassificacaoProcesso, string]>([
    ['concluido', 'ok'],
    ['limite_orcamento', 'etapa_estourou'],
    ['limite_turnos', 'etapa_estourou'],
    ['timeout', 'etapa_estourou'],
    ['cota', 'limite_cota'],
    ['interrompido', 'processo_interrompido'],
    ['erro_execucao', 'processo_interrompido'],
    ['autenticacao', 'processo_interrompido'],
  ])('%s → %s', (c, esperado) => {
    const d = desfechoDaClassificacao(c, ctx);
    expect(d.tipo === 'fato' ? d.evento.tipo : d.tipo).toBe(esperado);
  });

  it('saída inválida: 1 nova tentativa, depois falhou (03 §6)', () => {
    expect(desfechoDaClassificacao('saida_invalida', ctx).tipo).toBe('repetir_saida');
    const d = desfechoDaClassificacao('saida_invalida', { ...ctx, tentativasSaidaInvalida: 1 });
    expect(d).toMatchObject({
      tipo: 'fato',
      evento: { tipo: 'falha_infra', motivo: 'saida_invalida' },
    });
  });

  it('agente fora do papel reinicia 1×; depois perfil_divergente', () => {
    expect(
      desfechoDaClassificacao('perfil_divergente', { ...ctx, agentesForaDoPapel: 1 }).tipo,
    ).toBe('reiniciar_perfil');
    const d = desfechoDaClassificacao('perfil_divergente', {
      ...ctx,
      agentesForaDoPapel: 1,
      perfilJaReiniciado: true,
    });
    expect(d).toMatchObject({ tipo: 'fato', evento: { motivo: 'perfil_divergente' } });
  });

  it('pausa/cancelamento pedidos pelo humano não viram fato; sem pedido = interrupção', () => {
    expect(desfechoDaClassificacao('pausado', { ...ctx, paradaPedida: true }).tipo).toBe('parado');
    expect(desfechoDaClassificacao('cancelado', ctx)).toMatchObject({
      evento: { tipo: 'processo_interrompido' },
    });
  });

  it('etapa retomável fica interrompida; concluída/cancelada/falhou', () => {
    expect(estadoEtapaDaClassificacao('pausado')).toBe('interrompida');
    expect(estadoEtapaDaClassificacao('cota')).toBe('interrompida');
    expect(estadoEtapaDaClassificacao('cancelado')).toBe('cancelada');
    expect(estadoEtapaDaClassificacao('timeout')).toBe('falhou');
    expect(estadoEtapaDaClassificacao('concluido')).toBe('concluida');
  });
});

describe('contadores derivados das etapas', () => {
  it('retoma só a última etapa do tipo, do mesmo ciclo, interrompida e com sessão', () => {
    const i = etapa({ tipo: 'implementar', estado: 'interrompida', ciclo: 2 });
    expect(etapaParaRetomar([i], 'implementar', 2)).toBe(i);
    expect(etapaParaRetomar([i], 'implementar', 3)).toBeNull();
    expect(
      etapaParaRetomar([i, etapa({ tipo: 'implementar', ciclo: 2 })], 'implementar', 2),
    ).toBeNull();
  });

  it('textos de verificação (FJ-032): comandos do T1 e "como foi verificado" com refs', () => {
    expect(textoComandosDoStream([])).toContain('não rodou');
    expect(
      textoComandosDoStream([
        { comando: 'npm test', resultado: 'exit_0' },
        { comando: 'npm run lint', resultado: 'erro' },
      ]),
    ).toBe('- `npm test` → exit 0\n- `npm run lint` → com erro');
    const t = textoComoFoiVerificado(
      {
        nivel: 'declarado',
        motivo: 'não vistos no stream: npm run lint',
        comandos: [
          { comando: 'npm test', exit_code: 0, resumo: '', no_stream: 'exit_0' },
          { comando: 'npm run lint', exit_code: 0, resumo: '', no_stream: 'nao_visto' },
        ],
      },
      'abcdef0123456789',
    );
    expect(t).toContain('declarado');
    expect(t).toContain('ref `comando:1@abcdef01`');
    expect(t).not.toContain('comando:2@');
  });

  it('numstat soma linhas e conta binários como 0', () => {
    expect(somarNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n')).toEqual({
      arquivos: 3,
      adicoes: 13,
      remocoes: 1,
    });
  });
});

describe('telas (FJ-026)', () => {
  it('une plano e resumo por id e monta os pares', () => {
    const t = (id: string, rota = `/${id}`) => ({ id, descricao: id, rota, estado_esperado: 'x' });
    const telas = telasDaExecucao(
      { telas_afetadas: [t('UI1')] },
      { telas_afetadas: [t('UI1', '/outra'), t('UI2')] },
    );
    expect(telas.map((x) => [x.id, x.rota])).toEqual([
      ['UI1', '/UI1'],
      ['UI2', '/UI2'],
    ]);
    const pares = paresTelas(
      telas,
      [{ tela_id: 'UI1', rota: '/UI1', resultado: 'ok', artefato_id: 'a' }],
      [],
    );
    expect(pares).toEqual([
      { tela_id: 'UI1', antes: 'ok', depois: null },
      { tela_id: 'UI2', antes: null, depois: null },
    ]);
  });
});

describe('acoesDisponiveis (06 §4.2)', () => {
  const base: ContextoAcoes = {
    estado: 'implementando',
    estado_anterior: null,
    motivo: null,
    processo_vivo: true,
    assumida: false,
    existe_commit: true,
    tem_sessao: true,
    cliente_respondeu: false,
    sentinela_pendente: false,
    altera_ui: false,
  };

  it('agente rodando: pausar, parar, assumir, descartar (sem encerrar depois do commit)', () => {
    expect(acoesDisponiveis(base)).toEqual(['pausar', 'parar', 'assumir', 'descartar']);
  });

  it('pausado: retomar e conversar; terminal: nada', () => {
    expect(
      acoesDisponiveis({ ...base, estado: 'pausado_usuario', processo_vivo: false }),
    ).toContain('conversar');
    expect(acoesDisponiveis({ ...base, estado: 'concluido' })).toEqual([]);
  });

  it('precisa_humano depende do motivo; replanejar só antes do commit', () => {
    const ph = { ...base, estado: 'precisa_humano' as const, processo_vivo: false };
    expect(acoesDisponiveis({ ...ph, motivo: 'ciclos_esgotados' })).toEqual(
      expect.arrayContaining(['mais_um_ciclo', 'seguir_com_achados', 'assumir', 'descartar']),
    );
    expect(acoesDisponiveis({ ...ph, motivo: 'ciclos_esgotados' })).not.toContain('replanejar');
    // `base_vermelha` só em linha antiga (FJ-032): sem "seguir mesmo assim", replaneja.
    const antiga = acoesDisponiveis({ ...ph, motivo: 'base_vermelha', existe_commit: false });
    expect(antiga).toEqual(expect.arrayContaining(['replanejar', 'encerrar']));
    expect(antiga).not.toContain('mais_um_ciclo');
    expect(acoesDisponiveis({ ...ph, motivo: 'push_recusado' })).toContain('tentar_novamente');
  });

  it('assumida: devolver, sem assumir de novo; depois do merge não há descarte', () => {
    expect(
      acoesDisponiveis({
        ...base,
        estado: 'assumido_manual',
        assumida: true,
        processo_vivo: false,
      }),
    ).toEqual(['devolver', 'descartar']);
    expect(
      acoesDisponiveis({ ...base, estado: 'comunicando', processo_vivo: false }),
    ).not.toContain('descartar');
  });
});

describe('ações de precisa_humano conforme o motivo (03 §2.4; revisão B #24)', () => {
  const ph: ContextoAcoes = {
    estado: 'precisa_humano',
    estado_anterior: null,
    motivo: 'ia_servidor_ativa',
    processo_vivo: false,
    assumida: false,
    existe_commit: false,
    tem_sessao: true,
    cliente_respondeu: false,
    sentinela_pendente: false,
    altera_ui: false,
    teve_implementacao: false,
    seguir_com_achados_ok: false,
  };

  it('sem plano aprovado não há "mais um ciclo"; não implementável nunca', () => {
    expect(acoesDisponiveis(ph)).not.toContain('mais_um_ciclo');
    expect(acoesDisponiveis({ ...ph, teve_implementacao: true })).toContain('mais_um_ciclo');
    expect(
      acoesDisponiveis({ ...ph, motivo: 'nao_implementavel', teve_implementacao: true }),
    ).not.toContain('mais_um_ciclo');
    expect(maisUmCicloPermitido('ia_servidor_ativa', false, [])).toBe(false);
    expect(maisUmCicloPermitido('ciclos_esgotados', false, [etapa({ tipo: 'implementar' })])).toBe(
      true,
    );
    expect(maisUmCicloPermitido('nao_implementavel', true, [])).toBe(false);
  });

  it('"seguir com achados" só com o HEAD verificado E revisado', () => {
    const revisada = etapa({ tipo: 'revisar', estado: 'concluida', sha_inicio: 'a'.repeat(40) });
    const e = { sha_verificado: 'a'.repeat(40), sha_atual: 'a'.repeat(40) };
    expect(seguirComAchadosPermitido(e, [revisada])).toBe(true);
    expect(seguirComAchadosPermitido({ ...e, sha_atual: 'b'.repeat(40) }, [revisada])).toBe(false);
    expect(seguirComAchadosPermitido({ ...e, sha_verificado: null }, [revisada])).toBe(false);
    expect(seguirComAchadosPermitido(e, [])).toBe(false);
    expect(acoesDisponiveis({ ...ph, existe_commit: true })).not.toContain('seguir_com_achados');
  });

  it('terminal com sentinela pendente ainda oferece "Reconhecer" (o projeto segue travado)', () => {
    expect(acoesDisponiveis({ ...ph, estado: 'descartado', sentinela_pendente: true })).toEqual([
      'reconhecer_sentinela',
    ]);
  });
});

describe('retomada automática conta só crash (03 §3.3, §7.6; revisão B #41)', () => {
  it('retomada depois de cota/pausa não consome a retomada de crash', () => {
    const pausada = etapa({ estado: 'interrompida', motivo_fim: 'cota' });
    const retomada = etapa({ retomada: true, estado: 'interrompida', motivo_fim: 'interrompido' });
    expect(retomadasAutomaticas([pausada, retomada], 'implementar')).toBe(0);
    const crash = etapa({ estado: 'interrompida', motivo_fim: 'interrompido' });
    expect(retomadasAutomaticas([crash, retomada], 'implementar')).toBe(1);
    expect(retomadasAutomaticas([crash], 'implementar')).toBe(0);
  });
});

describe('suposições no relatório (FJ-033)', () => {
  const doPlano = ['Decisão: Onde mostrar o total? — adotado: no rodapé'];

  it('relator deixou vazio e o plano tem suposições → o app copia as do plano', () => {
    expect(suposicoesDoRelatorio({ suposicoes_assumidas: [] }, doPlano)).toEqual(doPlano);
  });

  it('relator preencheu → vale o texto dele (linguagem simples)', () => {
    expect(
      suposicoesDoRelatorio({ suposicoes_assumidas: ['O total aparece no rodapé.'] }, doPlano),
    ).toEqual(['O total aparece no rodapé.']);
  });

  it('relatório antigo sem o campo e plano sem suposições → []', () => {
    expect(suposicoesDoRelatorio({} as { suposicoes_assumidas: string[] }, [])).toEqual([]);
  });
});
