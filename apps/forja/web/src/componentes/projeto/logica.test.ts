import { describe, expect, it } from 'vitest';
import type { SistemaCasadoDto } from '@comum/dto';
import {
  alternarSistema,
  analisarAvancado,
  formularioDeConfig,
  montarConfig,
  nomeDaPasta,
  problemaPasta,
  sistemasEfetivos,
  textoDoAvancado,
} from './logica';

const sistema = (
  id: string | null,
  nome: string,
  sugerido: boolean,
  outro: string | null = null,
): SistemaCasadoDto => ({
  sistema_alvo_id: id,
  sistema_nome: nome,
  sugerido,
  ligado: false,
  outro_projeto: outro,
});
const detectados = [
  sistema('s1', 'ERP Web', true),
  sistema('s2', 'ERP Mobile', false),
  sistema(null, 'Site', false),
  sistema('s4', 'ERP Antigo', true, 'erp-legado'),
];

describe('projeto simplificado (FJ-030 §1, §5)', () => {
  it('nome padrão = basename da pasta; pasta precisa ser absoluta', () => {
    expect(nomeDaPasta('/home/voce/dev/erp-acme/')).toBe('erp-acme');
    expect(problemaPasta('')).toMatch(/informe/);
    expect(problemaPasta('dev/erp')).toMatch(/caminho completo/);
    expect(problemaPasta('/home/voce/dev/erp')).toBeNull();
  });

  it('sistemas: ausente = casamento automático; voltar ao automático limpa a lista', () => {
    expect(sistemasEfetivos(undefined, detectados)).toEqual(['s1']);
    expect(sistemasEfetivos([], detectados)).toEqual([]);
    // Sem id no Chamados, a chave é o nome; sugerido de outro projeto não entra no automático.
    const ligado = alternarSistema(undefined, detectados, 'Site', true);
    expect(ligado).toEqual(['s1', 'Site']);
    expect(alternarSistema(ligado, detectados, 'Site', false)).toBeUndefined();
    expect(alternarSistema(undefined, detectados, 's1', false)).toEqual([]);
  });

  it('Avançado: vazio ou {} = automático; JSON quebrado diz linha e coluna', () => {
    expect(analisarAvancado('')).toEqual({ ok: true, valor: undefined });
    expect(analisarAvancado(' {} ')).toEqual({ ok: true, valor: undefined });
    const quebrado = analisarAvancado('{\n  "gates": { "plano": "sempre", }\n}');
    expect(quebrado.ok).toBe(false);
    if (!quebrado.ok) expect(quebrado.erros[0]).toMatch(/JSON inválido/);
    expect(analisarAvancado('[1]')).toEqual({
      ok: false,
      erros: ['o Avançado precisa ser um objeto JSON { … }'],
    });
  });

  it('Avançado: erros do zod viram frases com o caminho da chave', () => {
    const r = analisarAvancado(
      JSON.stringify({
        comandos: { verificacao: [{ nome: 'test', comando: 'npm test', timeout_s: 0 }] },
        gates: { plano: 'talvez', exigir_prints: true },
        modo_reforcado: { ligado: 'sim' },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros).toEqual(
      expect.arrayContaining([
        'comandos.verificacao[0].timeout_s: mínimo 1',
        'gates.plano: use um de: "sempre", "por_risco", "nunca"',
        'gates: chave desconhecida: "exigir_prints"',
        'modo_reforcado.ligado: use true ou false',
      ]),
    );
  });

  it('Avançado: ida e volta do texto preserva o valor', () => {
    const valor = { gates: { plano: 'sempre' as const }, arquivos_locais: [] };
    const r = analisarAvancado(textoDoAvancado(valor));
    expect(r).toEqual({ ok: true, valor });
    expect(textoDoAvancado(undefined)).toBe('{}');
  });

  it('monta a config v2 só com o que foi informado', () => {
    const f = formularioDeConfig(null);
    f.repo_dir = '/home/voce/dev/erp-acme/';
    const r = montarConfig(f);
    expect(r).toEqual({
      ok: true,
      config: { versao: 2, nome: 'erp-acme', repo_dir: '/home/voce/dev/erp-acme' },
    });

    const cheio = montarConfig({
      nome: 'ERP',
      repo_dir: '/r',
      branch_destino: 'develop',
      sistemas: ['s2'],
      avancado_texto: '{"gates":{"plano":"nunca"}}',
    });
    expect(cheio.ok && cheio.config).toEqual({
      versao: 2,
      nome: 'ERP',
      repo_dir: '/r',
      branch_destino: 'develop',
      sistemas: ['s2'],
      avancado: { gates: { plano: 'nunca' } },
    });
  });

  it('recusa pasta relativa, branch inválida e Avançado inválido de uma vez', () => {
    const r = montarConfig({
      nome: '',
      repo_dir: 'relativo',
      branch_destino: 'main..x',
      sistemas: undefined,
      avancado_texto: '{"x":1}',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros.repo_dir).toMatch(/caminho completo/);
    expect(r.erros.branch_destino).toMatch(/inválido/);
    expect(r.avancado).toEqual(['chave desconhecida: "x"']);
  });
});
