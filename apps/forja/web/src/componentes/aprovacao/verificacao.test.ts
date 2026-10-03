import { describe, expect, it } from 'vitest';
import { linhasVerificacao } from './verificacao';

describe('linhasVerificacao (FJ-032)', () => {
  it('relatado × stream: visto, com erro e não visto', () => {
    const l = linhasVerificacao([
      { comando: 'npm run build', exit_code: 0, resumo: 'ok', no_stream: 'exit_0' },
      { comando: 'npm test', exit_code: 0, resumo: '', no_stream: 'erro' },
      { comando: 'npm run lint', exit_code: 0, resumo: '', no_stream: 'nao_visto' },
    ]);
    expect(l.map((x) => x.marca)).toEqual(['visto', 'falhou', 'declarado']);
    expect(l[2]?.detalhe).toContain('não visto');
  });

  it('artefato antigo (comando rodado pelo app) continua legível', () => {
    const l = linhasVerificacao([{ nome: 'unit', exit_code: 1, duracao_ms: 3, instavel: false }]);
    expect(l).toEqual([
      expect.objectContaining({ comando: 'unit', marca: 'falhou', exit_code: 1 }),
    ]);
  });

  it('vazio ou ausente → nenhuma linha', () => {
    expect(linhasVerificacao(undefined)).toEqual([]);
    expect(linhasVerificacao([null, 3])).toEqual([]);
  });
});
