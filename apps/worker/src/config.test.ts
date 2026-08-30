import { describe, it, expect } from 'vitest';
import { esforcoValido } from './config';
import { ESFORCO_PADRAO } from './ia/providers/claude-agent-provider';

/**
 * `IA_ESFORCO` (D-031): a fila de triagem não pode parar por um typo no `.env`,
 * então valor desconhecido cai no default em vez de derrubar o worker no boot.
 */
describe('esforcoValido (IA_ESFORCO — D-031)', () => {
  it('aceita os cinco níveis do SDK, sem sensibilidade a caixa ou espaço', () => {
    for (const n of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(esforcoValido(n)).toBe(n);
    }
    expect(esforcoValido('  HIGH ')).toBe('high');
  });

  it('ausente, vazio ou inválido → default high', () => {
    expect(esforcoValido(undefined)).toBe(ESFORCO_PADRAO);
    expect(esforcoValido('')).toBe(ESFORCO_PADRAO);
    expect(esforcoValido('altissimo')).toBe(ESFORCO_PADRAO);
    expect(ESFORCO_PADRAO).toBe('high');
  });
});
