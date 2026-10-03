import { describe, expect, it } from 'vitest';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import {
  enxugarEvento,
  MARCA_REDIGIDO,
  MAX_BYTES_PAYLOAD,
  Redator,
  REDATOR_GENERICO,
  resumirEntradaFerramenta,
  truncarTexto,
  umaLinha,
} from './normalizador';

describe('Redator (05 §8.2)', () => {
  it('troca valores conhecidos (mais longos primeiro) e ignora valores curtos', () => {
    const r = new Redator(['senha-do-banco', 'senha-do-banco-2', 'dev']);
    expect(r.redigir('a=senha-do-banco-2 b=senha-do-banco c=dev')).toBe(
      `a=${MARCA_REDIGIDO} b=${MARCA_REDIGIDO} c=dev`,
    );
  });

  it('redige também a forma escapada em JSON de um valor com aspas', () => {
    const r = new Redator(['p"ss\\word!']);
    const linha = JSON.stringify({ texto: 'DB_PASS=p"ss\\word!' });
    const redigida = r.redigir(linha);
    expect(redigida).not.toContain('ss');
    expect(JSON.parse(redigida)).toEqual({ texto: `DB_PASS=${MARCA_REDIGIDO}` });
  });

  it('padrões genéricos: GitHub, Anthropic, AWS, URL com senha, Bearer', () => {
    const r = REDATOR_GENERICO;
    expect(r.redigir('t=ghp_' + 'a'.repeat(36))).toBe(`t=${MARCA_REDIGIDO}`);
    expect(r.redigir('github_pat_' + 'A1_'.repeat(10))).toBe(MARCA_REDIGIDO);
    expect(r.redigir('ANTHROPIC_API_KEY=sk-ant-api03-abcDEF_123-xyz')).toBe(
      `ANTHROPIC_API_KEY=${MARCA_REDIGIDO}`,
    );
    expect(r.redigir('AKIAABCDEFGHIJKLMNOP')).toBe(MARCA_REDIGIDO);
    expect(r.redigir('postgres://app:s3gr3do@localhost:5432/db')).toBe(
      `postgres://app:${MARCA_REDIGIDO}@localhost:5432/db`,
    );
    expect(r.redigir('Authorization: Bearer abcdefghijklmnop123')).toBe(
      `Authorization: Bearer ${MARCA_REDIGIDO}`,
    );
    expect(r.redigir('http://localhost:3000/rota')).toBe('http://localhost:3000/rota');
  });

  it('chave PEM numa linha JSON do stream: some e o JSON continua válido', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----';
    const linha = JSON.stringify({ type: 'user', content: `cat id: ${pem} fim` });
    const redigida = REDATOR_GENERICO.redigir(linha);
    expect(JSON.parse(redigida)).toEqual({
      type: 'user',
      content: `cat id: ${MARCA_REDIGIDO} fim`,
    });
    const cortada = REDATOR_GENERICO.redigir(
      JSON.stringify({ c: '-----BEGIN RSA PRIVATE KEY-----\nAAA' }),
    );
    expect(JSON.parse(cortada)).toEqual({ c: MARCA_REDIGIDO });
  });
});

describe('truncamento e resumo', () => {
  it('trunca por code point e marca com reticências', () => {
    expect(truncarTexto('abc', 5)).toEqual({ texto: 'abc', truncado: false });
    expect(truncarTexto('abcdef', 4)).toEqual({ texto: 'abc…', truncado: true });
    const r = truncarTexto('😀😀😀😀', 3);
    expect(r.texto).toBe('😀😀…');
  });

  it('umaLinha colapsa quebras', () => {
    expect(umaLinha('a\n\n  b\tc')).toBe('a b c');
  });

  it('resume a entrada de cada ferramenta em uma linha', () => {
    expect(
      resumirEntradaFerramenta('Edit', { file_path: '/w/a.ts', old_string: 'x'.repeat(9999) }),
    ).toBe('/w/a.ts');
    expect(resumirEntradaFerramenta('Bash', { command: 'npm test\n&& echo fim' })).toBe(
      'npm test && echo fim',
    );
    expect(resumirEntradaFerramenta('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO em src');
    expect(
      resumirEntradaFerramenta('Agent', { subagent_type: 'implementador', description: 'passo 2' }),
    ).toBe('implementador: passo 2');
    expect(resumirEntradaFerramenta('TodoWrite', { todos: [{}, {}] })).toBe('2 itens');
    expect(resumirEntradaFerramenta('mcp__x__y', { a: 1 })).toBe('{"a":1}');
    expect(resumirEntradaFerramenta('Bash', { command: 'x'.repeat(1000) }).length).toBe(240);
    expect(resumirEntradaFerramenta('Bash', { command: 'export T=sk-ant-abcdefghijk1' })).toBe(
      `export T=${MARCA_REDIGIDO}`,
    );
  });
});

describe('enxugarEvento (02 §4.8: ≤ 8 KB)', () => {
  const texto = (t: string): NovoEventoForja => ({
    execucao_id: 'x',
    etapa_id: 'e',
    tipo: 'agente.texto',
    nivel: 'info',
    resumo: 'Falou\ncom quebra',
    dados: {
      texto: t,
      truncado: false,
      pensamento: false,
      papel_agente: 'condutor',
      parent_tool_use_id: null,
    },
  });

  it('não mexe no que já é enxuto (exceto o resumo em uma linha)', () => {
    const e = enxugarEvento(texto('oi'));
    expect(e.dados).toEqual(texto('oi').dados);
    expect(e.resumo).toBe('Falou com quebra');
  });

  it('trunca texto longo, marca truncado e respeita o teto em bytes', () => {
    const e = enxugarEvento(texto('ã'.repeat(50_000)));
    if (e.tipo !== 'agente.texto') throw new Error('tipo');
    expect(e.dados.truncado).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(e.dados))).toBeLessThanOrEqual(MAX_BYTES_PAYLOAD);
  });

  it('encolhe até caber quando há muitos campos longos', () => {
    const e = enxugarEvento(
      {
        execucao_id: null,
        etapa_id: null,
        tipo: 'cli.alerta',
        nivel: 'aviso',
        resumo: 'x',
        dados: { codigo: 'y'.repeat(3900), bloqueante: false },
      },
      { maxBytes: 1024 },
    );
    expect(Buffer.byteLength(JSON.stringify(e.dados))).toBeLessThanOrEqual(1024);
  });

  it('redige segredos em qualquer string do payload', () => {
    const r = new Redator(['token-de-boot-xyz']);
    const e = enxugarEvento(texto('vazou token-de-boot-xyz aqui'), { redator: r });
    if (e.tipo !== 'agente.texto') throw new Error('tipo');
    expect(e.dados.texto).toBe(`vazou ${MARCA_REDIGIDO} aqui`);
  });
});
