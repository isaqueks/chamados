import { describe, expect, it } from 'vitest';
import { planoFalso, resumoFalso, SHA_A, vereditoFalso } from './apoio-testes';
import {
  planoPreveUi,
  problemaCaminho,
  rotaRelativaValida,
  validarPlano,
  validarResumoImpl,
  validarVeredito,
  type ContextoResumoImpl,
} from './regras-contratos';

/** Regras de validação em código dos contratos (specs/forja/04 §6). */

const CTX = { arquivos_locais: ['.env.local', 'config/segredos'] };
const TELA = {
  id: 'UI1',
  descricao: 'Cadastro',
  rota: '/clientes/novo',
  estado_esperado: 'aviso abaixo do e-mail',
};

describe('caminhos e rotas', () => {
  it('recusa absoluto, `..`, arquivo local e .env*', () => {
    expect(problemaCaminho('/etc/passwd')).toBe('absoluto');
    expect(problemaCaminho('~/.ssh/id')).toBe('absoluto');
    expect(problemaCaminho('C:\\x')).toBe('absoluto');
    expect(problemaCaminho('a/../b')).toBe('sobe_diretorio');
    expect(problemaCaminho('./.env.local', CTX.arquivos_locais)).toBe('arquivo_local');
    expect(problemaCaminho('config/segredos/x.json', CTX.arquivos_locais)).toBe('arquivo_local');
    expect(problemaCaminho('apps/web/.env.production')).toBe('env');
    expect(problemaCaminho('./src//a.ts')).toBeNull();
  });

  it('rota relativa sem host nem `..`', () => {
    expect(rotaRelativaValida('/clientes?x=1')).toBe(true);
    expect(rotaRelativaValida('//evil.com/x')).toBe(false);
    expect(rotaRelativaValida('http://x/y')).toBe(false);
    expect(rotaRelativaValida('/a/../b')).toBe(false);
    expect(rotaRelativaValida('clientes')).toBe(false);
  });
});

describe('validarPlano', () => {
  it('plano feliz não tem erro', () => {
    const v = validarPlano(planoFalso(), CTX);
    expect(v.erros).toEqual([]);
    expect(v.corrigidos).toEqual([]);
  });

  it('implementável exige CA e passos; não implementável exige motivo', () => {
    expect(validarPlano(planoFalso({ criterios_de_aceite: [], passos: [] }), CTX).erros).toEqual([
      'plano sem critério de aceite',
      'plano sem passos',
    ]);
    expect(
      validarPlano(
        planoFalso({
          natureza_confirmada: 'nao_implementavel',
          criterios_de_aceite: [],
          passos: [],
        }),
        CTX,
      ).erros,
    ).toEqual(['nao_implementavel exige motivo_nao_implementavel']);
  });

  it('ids únicos, dependências existentes, grafo acíclico, e2e aponta para CA existente', () => {
    const passo = (id: string, depende_de: string[]) => ({
      id,
      descricao: 'x',
      arquivos_previstos: ['a.ts'],
      depende_de,
    });
    const v = validarPlano(
      planoFalso({
        arquivos_previstos: ['a.ts'],
        passos: [passo('P1', ['P2']), passo('P2', ['P1']), passo('P2', ['P9'])],
        criterios_de_aceite: [
          { id: 'CA1', descricao: 'x', verificacao: 'unit' },
          { id: 'CA1', descricao: 'y', verificacao: 'unit' },
        ],
        plano_de_testes: { unit: [], e2e: [{ criterio_id: 'CA5', roteiro: ['x'] }] },
      }),
      CTX,
    );
    expect(v.erros).toEqual(
      expect.arrayContaining([
        'critério de aceite repetido: CA1',
        'passo repetido: P2',
        'P2 depende de passo inexistente P9',
        'dependências entre passos formam um ciclo',
        'plano de testes e2e aponta para critério inexistente CA5',
      ]),
    );
  });

  it('caminhos proibidos recusam; .env e arquivos locais também viram alerta', () => {
    const v = validarPlano(planoFalso({ arquivos_previstos: ['.env', '/abs.ts'] }), CTX);
    expect(v.erros).toEqual(
      expect.arrayContaining([
        'caminho recusado (env): .env',
        'caminho recusado (absoluto): /abs.ts',
      ]),
    );
    expect(v.alertas).toEqual(['o plano prevê mexer em arquivo local/segredo: .env']);
  });

  it('arquivos_previstos ⊇ união dos passos: o app corrige e registra', () => {
    const v = validarPlano(planoFalso({ arquivos_previstos: [] }), CTX);
    expect(v.erros).toEqual([]);
    expect(v.corrigidos).toEqual(['servicos/relatorio.ts']);
    expect(v.arquivos_previstos).toEqual(['servicos/relatorio.ts']);
  });

  it('schema: altera ⇔ mudanças ⇔ área', () => {
    expect(
      validarPlano(planoFalso({ schema_banco: { altera: true, mudancas: [] } }), CTX).erros,
    ).toHaveLength(1);
    expect(validarPlano(planoFalso({ areas: ['schema_banco'] }), CTX).erros).toHaveLength(1);
  });

  it('FJ-026: ui ⇔ telas; ids únicos; rota relativa (sem DSL de passos desde FJ-030)', () => {
    expect(validarPlano(planoFalso({ areas: ['ui'] }), CTX).erros).toEqual([
      'areas ∋ ui exige telas_afetadas não vazio (e vice-versa)',
    ]);
    expect(validarPlano(planoFalso({ telas_afetadas: [TELA] }), CTX).erros).toHaveLength(1);
    const v = validarPlano(
      planoFalso({
        areas: ['ui'],
        telas_afetadas: [TELA, { ...TELA, rota: '//host/x' }],
      }),
      CTX,
    );
    expect(v.erros).toEqual(
      expect.arrayContaining([
        'tela: id de tela repetido UI1',
        'tela UI1: rota "//host/x" não é relativa (sem host, sem "..")',
      ]),
    );
    expect(validarPlano(planoFalso({ areas: ['ui'], telas_afetadas: [TELA] }), CTX).erros).toEqual(
      [],
    );
  });

  it('planoPreveUi: área, telas ou arquivo de frontend', () => {
    const fe = (c: string) => c.endsWith('.tsx');
    expect(planoPreveUi(planoFalso(), fe)).toBe(false);
    expect(planoPreveUi(planoFalso({ arquivos_previstos: ['a/b.tsx'] }), fe)).toBe(true);
    expect(planoPreveUi(planoFalso({ areas: ['ui'] }), fe)).toBe(true);
  });
});

describe('validarResumoImpl', () => {
  const ctx: ContextoResumoImpl = {
    ciclo: 1,
    plano: planoFalso(),
    arquivos_reais: ['servicos/relatorio.ts'],
    lockfile_mudou: false,
    head_igual_checkpoint: true,
  };

  it('feliz', () => {
    expect(validarResumoImpl(resumoFalso(), ctx)).toEqual({
      erros: [],
      avisos: [],
      fora_do_plano: [],
      revisao_seguranca_obrigatoria: false,
      bloqueios: [],
      agente_versionou: false,
    });
  });

  it('ciclo e passos devem bater com o plano', () => {
    const v = validarResumoImpl(
      resumoFalso({
        ciclo: 2,
        passos: [{ ...resumoFalso().passos[0]!, id: 'P9' }],
      }),
      ctx,
    );
    expect(v.erros).toEqual([
      'ciclo 2 ≠ ciclo do app 1',
      'passo P9 não existe no plano',
      'passo P1 do plano não aparece no resumo',
    ]);
  });

  it('declarado × git: aviso, vale o git; fora do plano vai ao T2', () => {
    const v = validarResumoImpl(resumoFalso(), {
      ...ctx,
      arquivos_reais: ['servicos/relatorio.ts', 'util/novo.ts', 'docs/x.md'],
    });
    expect(v.avisos[0]).toContain('util/novo.ts');
    expect(v.fora_do_plano).toEqual(['docs/x.md', 'util/novo.ts']);
    const comDesvio = validarResumoImpl(
      resumoFalso({ desvios_do_plano: [{ arquivo: 'util/novo.ts', motivo: 'helper' }] }),
      { ...ctx, arquivos_reais: ['servicos/relatorio.ts', 'util/novo.ts'] },
    );
    expect(comDesvio.fora_do_plano).toEqual([]);
  });

  it('dependência nova sem previsão → revisão de segurança obrigatória', () => {
    expect(
      validarResumoImpl(resumoFalso({ dependencias_adicionadas: ['left-pad'] }), ctx)
        .revisao_seguranca_obrigatoria,
    ).toBe(true);
    expect(
      validarResumoImpl(resumoFalso(), { ...ctx, lockfile_mudou: true })
        .revisao_seguranca_obrigatoria,
    ).toBe(true);
    expect(
      validarResumoImpl(resumoFalso({ dependencias_adicionadas: ['zod'] }), {
        ...ctx,
        plano: planoFalso({ dependencias_previstas: [{ pacote: 'zod', motivo: 'validação' }] }),
      }).revisao_seguranca_obrigatoria,
    ).toBe(false);
  });

  it('bloqueios e HEAD fora do checkpoint', () => {
    const v = validarResumoImpl(
      resumoFalso({ bloqueios: [{ descricao: 'sem acesso', precisa: 'ambiente' }] }),
      { ...ctx, head_igual_checkpoint: false },
    );
    expect(v.bloqueios).toEqual(['ambiente: sem acesso']);
    expect(v.agente_versionou).toBe(true);
  });

  it('FJ-026: telas do resumo só novas (fora do plano) e bem formadas', () => {
    const v = validarResumoImpl(resumoFalso({ telas_afetadas: [TELA] }), {
      ...ctx,
      plano: planoFalso({ areas: ['ui'], telas_afetadas: [TELA] }),
    });
    expect(v.erros).toEqual([
      'tela UI1 já está no plano (declare só telas novas)',
      'rota /clientes/novo já está no plano (declare só telas novas)',
    ]);
    expect(
      validarResumoImpl(resumoFalso({ telas_afetadas: [{ ...TELA, id: 'UI2', rota: '/lista' }] }), {
        ...ctx,
        plano: planoFalso({ areas: ['ui'], telas_afetadas: [TELA] }),
      }).erros,
    ).toEqual([]);
  });
});

describe('validarVeredito', () => {
  const ctx = {
    sha_verificado: SHA_A,
    ids_criterios: ['CA1'],
    refs_validas: ['log:unit@aaaaaaaa'],
    revisao_seguranca_obrigatoria: false,
  };

  it('feliz', () => {
    expect(validarVeredito(vereditoFalso(), ctx)).toEqual({
      valido: true,
      motivo_invalido: null,
      erros: [],
      incoerencias: [],
      decisao_efetiva: 'aprovado',
    });
  });

  it('sha_avaliado ≠ sha_verificado → inválido', () => {
    const v = validarVeredito(vereditoFalso({ sha_avaliado: 'c'.repeat(40) }), ctx);
    expect(v.valido).toBe(false);
    expect(v.motivo_invalido).toContain('cccccccc');
  });

  it('critérios exatamente os do plano; refs listadas; segurança obrigatória', () => {
    const v = validarVeredito(
      vereditoFalso({
        criterios: [
          { id: 'CA2', status: 'atendido', evidencia: 'x', evidencia_ref: 'artefato:zzz' },
        ],
      }),
      { ...ctx, revisao_seguranca_obrigatoria: true },
    );
    expect(v.erros).toEqual([
      'critério CA1 do plano sem avaliação',
      'critério CA2 não existe no plano',
      'CA2: evidencia_ref "artefato:zzz" não é uma ref listada',
      'revisão de segurança obrigatória sem revisor_seguranca',
    ]);
  });

  it('aprovado com bloqueante ou CA não atendido → reprovado + incoerência', () => {
    const v = validarVeredito(
      vereditoFalso({
        criterios: [{ id: 'CA1', status: 'nao_atendido', evidencia: 'x', evidencia_ref: null }],
      }),
      ctx,
    );
    expect(v.decisao_efetiva).toBe('reprovado');
    expect(v.incoerencias).toHaveLength(1);
  });
});
