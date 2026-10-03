import { describe, expect, it } from 'vitest';
import { formatarCustoEquivalente, formatarPercentual, medicaoRecente, tomCota } from './formato';

describe('formato do shell (06 §1.2)', () => {
  it('custo em micro-dólares vira "US$ x,yy equiv."', () => {
    expect(formatarCustoEquivalente(12_400_000)).toBe('US$ 12,40 equiv.');
    expect(formatarCustoEquivalente(0)).toBe('US$ 0,00 equiv.');
  });

  it('percentual arredonda para baixo', () => {
    expect(formatarPercentual(0.239)).toBe('23%');
    expect(formatarPercentual(-1)).toBe('0%');
  });

  it('termômetro: neutro < limiar−10pp ≤ âmbar < limiar ≤ vermelho', () => {
    expect(tomCota(0.69, 0.8)).toBe('neutro');
    expect(tomCota(0.7, 0.8)).toBe('ambar');
    expect(tomCota(0.79, 0.8)).toBe('ambar');
    expect(tomCota(0.8, 0.8)).toBe('vermelho');
  });

  it('medição recente = até 30 min', () => {
    const agora = new Date('2026-10-02T12:00:00Z');
    expect(medicaoRecente('2026-10-02T11:31:00Z', agora)).toBe(true);
    expect(medicaoRecente('2026-10-02T11:29:00Z', agora)).toBe(false);
    expect(medicaoRecente(null, agora)).toBe(false);
  });
});
