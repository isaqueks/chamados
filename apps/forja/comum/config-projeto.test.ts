import { describe, expect, it } from 'vitest';
import {
  AvancadoProjetoSchema,
  ConfigProjetoSchema,
  configProjetoDeResolvida,
  configResolvidaPadrao,
  configuracoesGlobaisPadrao,
  converterConfigV1,
  detectadoVazio,
  resolverConfig,
} from './config-projeto';

describe('ConfigProjeto v2 (FJ-030 §1)', () => {
  it('só repo_dir: versão 2 e nome = pasta', () => {
    expect(ConfigProjetoSchema.parse({ repo_dir: '/src/portal-cliente/' })).toEqual({
      versao: 2,
      nome: 'portal-cliente',
      repo_dir: '/src/portal-cliente',
    });
  });

  it('caminho relativo e avançado com chave desconhecida são recusados', () => {
    expect(ConfigProjetoSchema.safeParse({ repo_dir: 'src/x' }).success).toBe(false);
    expect(AvancadoProjetoSchema.safeParse({ gatez: {} }).success).toBe(false);
    expect(AvancadoProjetoSchema.safeParse({ gates: { plano: 'sempre', x: 1 } }).success).toBe(
      false,
    );
    expect(AvancadoProjetoSchema.safeParse({ gates: { plano: 'sempre' } }).success).toBe(true);
  });

  it('FJ-031: chaves de IA do servidor num avançado antigo são aceitas e descartadas', () => {
    const r = AvancadoProjetoSchema.parse({
      gates: { plano: 'sempre', pre_condicao_ia_silenciada: false },
      politica_status: { motivo: 'x', reativar_ia_ao_concluir: true },
    });
    expect(r).toEqual({ gates: { plano: 'sempre' }, politica_status: { motivo: 'x' } });
  });

  it('configProjetoDeResolvida resolve exatamente para a configuração de origem', () => {
    const r = configResolvidaPadrao({
      dir: '/src/app',
      remoto: 'origin',
      branch_destino: 'develop',
      prefixo_branch: 'forja/',
    });
    r.comandos.verificacao = [{ nome: 'lint', comando: 'npm run lint', timeout_s: 60 }];
    r.limites.ciclos.max_auto = 1;
    const v2 = configProjetoDeResolvida('App', r);
    expect(resolverConfig(v2, configuracoesGlobaisPadrao(), detectadoVazio('/src/app'))).toEqual(r);
  });

  it('converterConfigV1: só o que difere dos padrões vai para o avançado; modelos e evidências saem', () => {
    const base = configResolvidaPadrao({
      dir: '/src/app',
      remoto: 'origin',
      branch_destino: 'main',
      prefixo_branch: 'forja/',
    });
    const enxuto = converterConfigV1('App', base);
    expect(enxuto).toEqual({
      versao: 2,
      nome: 'App',
      repo_dir: '/src/app',
      branch_destino: 'main',
    });
    const proprio = converterConfigV1('App', {
      ...base,
      repo: { ...base.repo, remoto: null },
      entrega: { ...base.entrega, modo: 'merge_local' },
      gates: { ...base.gates, plano: 'sempre' },
      limites: {
        ...base.limites,
        orcamento_usd: { ...base.limites.orcamento_usd, implementar: 50 },
      },
    });
    expect(proprio.avancado).toEqual({
      repo: { remoto: null },
      gates: { plano: 'sempre' },
      limites: { orcamento_usd: { implementar: 50 } },
    });
    expect(
      resolverConfig(proprio, configuracoesGlobaisPadrao(), detectadoVazio('/src/app')).entrega
        .modo,
    ).toBe('merge_local');
  });
});
