import { describe, expect, it } from 'vitest';
import type { ConexaoDto, ProjetoResumoDto } from '@comum/dto';
import { deveIrAoOnboarding, passoInicial, precisaOnboarding } from './logica';

const conexao = (estado: ConexaoDto['estado']) => ({ id: 'c', estado }) as ConexaoDto;
const projeto = { id: 'p' } as ProjetoResumoDto;

describe('onboarding (FJ-030 §5)', () => {
  it('só decide com as duas listas carregadas', () => {
    expect(precisaOnboarding(undefined, [])).toBeNull();
    expect(precisaOnboarding([], undefined)).toBeNull();
    expect(precisaOnboarding([], [projeto])).toBe(true);
    expect(precisaOnboarding([conexao('ok')], [])).toBe(true);
    expect(precisaOnboarding([conexao('ok')], [projeto])).toBe(false);
  });

  it('começa no Projeto quando já há conexão funcionando', () => {
    expect(passoInicial([])).toBe('conexao');
    expect(passoInicial([conexao('erro')])).toBe('conexao');
    expect(passoInicial([conexao('erro'), conexao('ok')])).toBe('projeto');
  });

  it('só a Fila (e a raiz) redirecionam', () => {
    expect(deveIrAoOnboarding('/fila', true)).toBe(true);
    expect(deveIrAoOnboarding('/', true)).toBe(true);
    expect(deveIrAoOnboarding('/diagnostico', true)).toBe(false);
    expect(deveIrAoOnboarding('/fila', false)).toBe(false);
    expect(deveIrAoOnboarding('/fila', null)).toBe(false);
  });
});
