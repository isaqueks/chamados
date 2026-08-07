import { describe, it, expect } from 'vitest';
import { montarQueryListar, caminhoChamado } from './ferramentas';

/** Tradução de argumentos das ferramentas → contrato HTTP (specs/11 §4.1/§7.2). */
describe('ferramentas do MCP', () => {
  it('serializa a lista de status separada por vírgula', () => {
    const q = montarQueryListar({ status: ['novo', 'em_triagem'] });
    expect(q.status).toBe('novo,em_triagem');
  });

  it('omite filtros ausentes (nada de parâmetro vazio na URL)', () => {
    const q = montarQueryListar({});
    expect(Object.values(q).every((v) => v === undefined)).toBe(true);
  });

  it('omite `status` quando a lista vem vazia', () => {
    expect(montarQueryListar({ status: [] }).status).toBeUndefined();
  });

  it('converte limite numérico para string', () => {
    expect(montarQueryListar({ limite: 50 }).limite).toBe('50');
  });

  it('escapa a referência do chamado no caminho', () => {
    expect(caminhoChamado('12')).toBe('/api/v1/chamados/12');
    // `#` viraria fragmento de URL se não fosse escapado — o número sumiria.
    expect(caminhoChamado('#12')).toBe('/api/v1/chamados/%2312');
    expect(caminhoChamado(' 12 ', '/mensagens')).toBe('/api/v1/chamados/12/mensagens');
  });
});
