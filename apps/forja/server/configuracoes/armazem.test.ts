import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AvancadoProjetoSchema,
  configuracoesGlobaisPadrao,
  configResolvidaPadrao,
  detectadoVazio,
  resolverConfig,
} from '../../comum/config-projeto';
import { ArmazemConfiguracoes, ErroConfiguracoes } from './armazem';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configurações globais (FJ-030 §2)', () => {
  it('padrões da nota: Fable/Opus high, cota 0,80/0,90, concorrência 2·3, ciclos 2/5', () => {
    const c = configuracoesGlobaisPadrao();
    expect(c.modelos).toEqual({
      orquestrador: { modelo: 'claude-fable-5-1', esforco: 'high' },
      subagentes: { modelo: 'claude-opus-5-5', esforco: 'high' },
    });
    expect(c.cota).toEqual({ five_hour: 0.8, seven_day: 0.9, permitir_creditos_extras: false });
    expect(c.concorrencia).toEqual({ implementacoes: 2, planejadores: 3 });
    expect(c.limites.ciclos).toEqual({ max_auto: 2, max_total: 5 });
    expect(c.limites.orcamento_usd).toEqual({
      planejar: 5,
      implementar: 25,
      revisar: 10,
      relatar: 2,
      por_chamado: 40,
    });
    expect(c.limites.timeout_min).toMatchObject({
      planejar: 15,
      implementar: 90,
      revisar: 45,
      relatar: 5,
    });
    // FJ-034: G1 desligado por padrão; o G2 não tem exigências configuráveis.
    expect(c.gates).toEqual({ plano: 'nunca' });
  });

  it('FJ-034: configuracoes.json antigo com exigir_prints_ui/exigir_ciente_mensagem_nova carrega e descarta', () => {
    const a = new ArmazemConfiguracoes(dir);
    writeFileSync(
      a.caminho,
      JSON.stringify({
        gates: { plano: 'por_risco', exigir_prints_ui: false, exigir_ciente_mensagem_nova: true },
      }),
    );
    expect(a.ler().gates).toEqual({ plano: 'por_risco' });
  });

  it('FJ-031: configuracoes.json antigo com pre_condicao_ia_silenciada carrega e descarta a chave', () => {
    const a = new ArmazemConfiguracoes(dir);
    writeFileSync(a.caminho, JSON.stringify({ gates: { pre_condicao_ia_silenciada: false } }));
    expect(a.ler().gates).not.toHaveProperty('pre_condicao_ia_silenciada');
  });

  it('FJ-032: arquivo/Avançado antigo com verificações e correções de verificação é aceito e descarta as chaves', () => {
    writeFileSync(
      new ArmazemConfiguracoes(dir).caminho,
      JSON.stringify({
        concorrencia: { implementacoes: 3, verificacoes: 2 },
        limites: { ciclos: { max_auto: 1, max_correcoes_verificacao: 3 } },
      }),
    );
    const c = new ArmazemConfiguracoes(dir).ler();
    expect(c.concorrencia).toEqual({ implementacoes: 3, planejadores: 3 });
    expect(c.limites.ciclos).toEqual({ max_auto: 1, max_total: 5 });
    const av = AvancadoProjetoSchema.parse({
      limites: {
        concorrencia: { agentes: 1, verificacoes: 4 },
        ciclos: { max_correcoes_verificacao: 2 },
      },
      comandos: {
        verificacao: [{ nome: 'lint', comando: 'npm run lint', timeout_s: 60, rapido: true }],
      },
    });
    expect(av.limites).toEqual({ concorrencia: { agentes: 1 }, ciclos: {} });
    expect(av.comandos?.verificacao).toEqual([
      { nome: 'lint', comando: 'npm run lint', timeout_s: 60 },
    ]);
  });

  it('arquivo ausente = padrões, sem gravar', () => {
    const a = new ArmazemConfiguracoes(dir);
    expect(a.ler()).toEqual(configuracoesGlobaisPadrao());
    expect(() => statSync(a.caminho)).toThrow();
  });

  it('gravar completa o parcial, grava 0600 e avisa os ouvintes; restaurar volta aos padrões', () => {
    const a = new ArmazemConfiguracoes(dir);
    const vistos: number[] = [];
    a.aoMudar((c) => vistos.push(c.concorrencia.implementacoes));
    const c = a.gravar({ concorrencia: { implementacoes: 4 }, gates: { plano: 'sempre' } });
    expect(c.concorrencia).toEqual({ implementacoes: 4, planejadores: 3 });
    expect(c.gates.plano).toBe('sempre');
    expect(statSync(a.caminho).mode & 0o777).toBe(0o600);
    expect(new ArmazemConfiguracoes(dir).ler().concorrencia.implementacoes).toBe(4);
    expect(a.restaurar()).toEqual(configuracoesGlobaisPadrao());
    expect(JSON.parse(readFileSync(a.caminho, 'utf8'))).toEqual(configuracoesGlobaisPadrao());
    expect(vistos).toEqual([4, 2]);
  });

  it('valor inválido é erro com o campo; arquivo corrompido não vira padrão em silêncio', () => {
    const a = new ArmazemConfiguracoes(dir);
    try {
      a.gravar({ cota: { five_hour: 3 }, limites: { ciclos: { max_auto: 9, max_total: 5 } } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ErroConfiguracoes);
      const campos = (e as ErroConfiguracoes).problemas.map((p) => p.campo);
      expect(campos).toContain('cota.five_hour');
    }
    writeFileSync(a.caminho, '{ quebrado');
    expect(() => new ArmazemConfiguracoes(dir).ler()).toThrow(/não é JSON válido/);
  });
});

describe('resolverConfig (FJ-030 §1)', () => {
  const detectado = {
    ...detectadoVazio('/src/app'),
    branch_destino: 'trunk',
    remoto: 'origin',
    comandos: {
      ...detectadoVazio('/src/app').comandos,
      setup: { comando: 'npm ci', timeout_s: 900 },
      verificacao: [{ nome: 'lint', comando: 'npm run lint', timeout_s: 600 }],
    },
  };

  it('só repo_dir: tudo vem do detectado e das globais', () => {
    const g = configuracoesGlobaisPadrao();
    const r = resolverConfig({ repo_dir: '/src/app' }, g, detectado);
    expect(r.repo).toEqual({
      dir: '/src/app',
      remoto: 'origin',
      branch_destino: 'trunk',
      prefixo_branch: 'forja/',
    });
    expect(r.entrega.modo).toBe('merge_e_push');
    expect(r.comandos.setup?.comando).toBe('npm ci');
    expect(r.modelos.planejador).toEqual(g.modelos.orquestrador);
    expect(r.modelos.subagentes.modelo).toBe('claude-opus-5-5');
    expect(r.limites.concorrencia).toEqual({
      agentes: 2,
      planejadores: 3,
      schema_em_voo: 1,
    });
    expect(r.limites.freio_cota).toEqual(g.cota);
    expect(r.gates).toEqual({ plano: 'nunca' });
  });

  it('branch do projeto e Avançado vencem globais e detectado; sem remoto = merge_local', () => {
    const g = {
      ...configuracoesGlobaisPadrao(),
      gates: { ...configuracoesGlobaisPadrao().gates, plano: 'nunca' as const },
    };
    const r = resolverConfig(
      {
        repo_dir: '/src/app',
        branch_destino: 'develop',
        avancado: {
          repo: { remoto: null },
          comandos: { verificacao: [] },
          gates: { plano: 'sempre' },
          limites: { orcamento_usd: { implementar: 50 } },
        },
      },
      g,
      detectado,
    );
    expect(r.repo.branch_destino).toBe('develop');
    expect(r.repo.remoto).toBeNull();
    expect(r.entrega.modo).toBe('merge_local');
    expect(r.comandos.verificacao).toEqual([]);
    expect(r.comandos.setup?.comando).toBe('npm ci');
    expect(r.gates.plano).toBe('sempre');
    expect(r.limites.orcamento_usd.implementar).toBe(50);
    expect(r.limites.orcamento_usd.revisar).toBe(10);
  });

  it('configResolvidaPadrao: base neutra (sem comandos nem detectores)', () => {
    const r = configResolvidaPadrao({
      dir: '/x',
      remoto: 'origin',
      branch_destino: 'main',
      prefixo_branch: 'forja/',
    });
    expect(r.comandos.verificacao).toEqual([]);
    expect(r.detectores.frontend).toEqual([]);
    expect(r.entrega.modo).toBe('merge_e_push');
  });
});
