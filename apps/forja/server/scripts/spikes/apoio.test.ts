import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MensagemCli } from '../../claude/stream';
import {
  argsParaRegistro,
  carregarEnvArquivo,
  foiNegado,
  intervalosSubagentes,
  modelosUsados,
  negacoesDoResult,
  recorteCota,
  resumirStream,
  sobrepoem,
  textoDaTela,
  ultimoResult,
  usoDoResult,
  vereditoDe,
  vereditoGeral,
  type Criterio,
  type MensagemDatada,
} from './apoio';
import { coletarCotas } from './spike-s5';
import { revisaoInstalada } from './spike-s10';

/**
 * Só a lógica PURA dos spikes (specs/forja/08 §2): os spikes em si chamam a
 * CLI real e nunca rodam no vitest.
 */

const m = (t: number, msg: MensagemCli): MensagemDatada => ({ t, m: msg });

const criterio = (veredito: Criterio['veredito']): Criterio => ({
  id: 'x',
  descricao: 'x',
  veredito,
  detalhe: '',
});

describe('vereditos', () => {
  it('converte booleano/nulo', () => {
    expect(vereditoDe(true)).toBe('PASSOU');
    expect(vereditoDe(false)).toBe('FALHOU');
    expect(vereditoDe(null)).toBe('PENDENTE');
  });

  it('qualquer FALHOU reprova; só PENDENTE fica PENDENTE', () => {
    expect(vereditoGeral([criterio('PASSOU'), criterio('FALHOU')])).toBe('FALHOU');
    expect(vereditoGeral([criterio('PASSOU'), criterio('PENDENTE')])).toBe('PASSOU');
    expect(vereditoGeral([criterio('PENDENTE')])).toBe('PENDENTE');
    expect(vereditoGeral([])).toBe('PENDENTE');
  });
});

describe('resumirStream', () => {
  const stream: MensagemDatada[] = [
    m(0, { type: 'system', subtype: 'init', session_id: 's', tools: ['Task'] }),
    m(10, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'Agent',
            input: { subagent_type: 'revisor_correcao' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'Agent',
            input: { subagent_type: 'revisor_seguranca' },
          },
        ],
      },
    }),
    m(12, {
      type: 'system',
      subtype: 'task_started',
      tool_use_id: 'a',
      subagent_type: 'revisor_correcao',
    }),
    m(13, {
      type: 'system',
      subtype: 'task_started',
      tool_use_id: 'b',
      subagent_type: 'revisor_seguranca',
    }),
    m(20, {
      type: 'user',
      parent_tool_use_id: 'a',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'negado' }],
      },
    }),
    m(30, { type: 'system', subtype: 'task_notification', tool_use_id: 'a' }),
    m(40, { type: 'system', subtype: 'task_notification', tool_use_id: 'b' }),
    m(41, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 99,
        unifiedWindows: { five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.2 } },
      },
    }),
    m(50, {
      type: 'result',
      subtype: 'success',
      result_index: 0,
      total_cost_usd: 0.5,
      usage: {
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7,
        input_tokens: 3,
        output_tokens: 4,
      },
      modelUsage: { 'claude-opus-5-5': {}, 'claude-fable-5-1': {} },
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push origin x' } }],
    }),
    m(51, { type: 'result', subtype: 'error_during_execution', result_index: 1 }),
  ];
  const s = resumirStream(stream);

  it('separa init, results, cota, usos e resultados de ferramenta', () => {
    expect(s.inits).toHaveLength(1);
    expect(s.results).toHaveLength(2);
    expect(s.rateLimits).toHaveLength(1);
    expect(s.usos.map((u) => u.id)).toEqual(['a', 'b']);
    expect(s.usos.every((u) => u.mensagemId === 'msg_1' && u.pai === null)).toBe(true);
    expect(s.resultados[0]).toMatchObject({
      toolUseId: 'x',
      erro: true,
      texto: 'negado',
      pai: 'a',
    });
  });

  it('vale o result de maior result_index', () => {
    expect(ultimoResult(s)?.subtype).toBe('error_during_execution');
  });

  it('negações, modelos e uso saem do result', () => {
    const r = s.results[0] ?? null;
    const neg = negacoesDoResult(r);
    expect(foiNegado(neg, 'git push')).toBe(true);
    expect(foiNegado(neg, 'git remote')).toBe(false);
    expect(modelosUsados(r)).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
    expect(usoDoResult(r)).toEqual({
      custo: 0.5,
      cache_read: 100,
      cache_creation: 7,
      input: 3,
      output: 4,
    });
  });

  it('intervalos dos subagentes e sobreposição (paralelo)', () => {
    const iv = intervalosSubagentes(s);
    expect(iv).toEqual([
      { nome: 'revisor_correcao', inicio: 12, fim: 30 },
      { nome: 'revisor_seguranca', inicio: 13, fim: 40 },
    ]);
    expect(sobrepoem(iv[0]!, iv[1]!)).toBe(true);
    expect(sobrepoem({ nome: 'a', inicio: 0, fim: 5 }, { nome: 'b', inicio: 5, fim: 9 })).toBe(
      false,
    );
  });

  it('recorte da cota', () => {
    expect(recorteCota(s.rateLimits[0]!.info, 't')).toEqual({
      t: 't',
      status: 'allowed',
      cinco_horas: 0.3,
      sete_dias: 0.2,
      resetsAt: 99,
    });
  });
});

describe('textoDaTela', () => {
  it('tira ANSI/OSC e transforma o avanço de cursor em espaço', () => {
    const bruto = '\x1b]0;título\x07\x1b[1mYes,\x1b[1CI\x1b[22m trust\r\n\x1b[?25lJABUTICABA-8';
    const t = textoDaTela(bruto);
    expect(t).toContain('Yes, I trust');
    expect(t).toContain('JABUTICABA-8');
    expect(t).not.toContain('\x1b');
  });
});

describe('arquivos', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('argsParaRegistro esconde o schema', () => {
    expect(argsParaRegistro(['-p', '--json-schema', '{"a":1}'])).toEqual([
      '-p',
      '--json-schema',
      '<json-schema 7 bytes>',
    ]);
  });

  it('carregarEnvArquivo não sobrescreve o ambiente e tira aspas', () => {
    dir = mkdtempSync(join(tmpdir(), 'spike-env-'));
    const arq = join(dir, '.env');
    writeFileSync(arq, '# comentário\nSPIKE_TESTE_A="um"\nSPIKE_TESTE_B=dois\nPATH=nao\n');
    const caminho = process.env.PATH;
    try {
      expect(carregarEnvArquivo(arq)).toEqual(['SPIKE_TESTE_A', 'SPIKE_TESTE_B']);
      expect(process.env.SPIKE_TESTE_A).toBe('um');
      expect(process.env.PATH).toBe(caminho);
    } finally {
      delete process.env.SPIKE_TESTE_A;
      delete process.env.SPIKE_TESTE_B;
    }
  });

  it('revisaoInstalada escolhe a revisão completa mais nova', () => {
    dir = mkdtempSync(join(tmpdir(), 'spike-pw-'));
    for (const [d, completa] of [
      ['chromium_headless_shell-1217', true],
      ['chromium_headless_shell-1234', true],
      ['chromium_headless_shell-1300', false],
      ['chromium-1999', true],
    ] as const) {
      mkdirSync(join(dir, d));
      if (completa) writeFileSync(join(dir, d, 'INSTALLATION_COMPLETE'), '');
    }
    expect(revisaoInstalada(dir, 'chromium_headless_shell')?.rev).toBe(1234);
    expect(revisaoInstalada(join(dir, 'nada'), 'chromium')).toBeNull();
  });

  it('coletarCotas lê os rate_limit_event dos streams gravados', () => {
    dir = mkdtempSync(join(tmpdir(), 'spike-cota-'));
    mkdirSync(join(dir, 's2'));
    writeFileSync(
      join(dir, 's2', 't1.jsonl'),
      [
        '{"type":"system","subtype":"init"}',
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1}}}}',
        'não é json',
      ].join('\n'),
    );
    const c = coletarCotas(dir);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ status: 'allowed', cinco_horas: 0.1, origem: 's2/t1.jsonl' });
  });
});
