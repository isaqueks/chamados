import { describe, it, expect, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { resolverJobs } from './dispatcher';

/**
 * D-043: o `custo_final_definido` gravado NO ATO de resolver (`origem:
 * 'resolucao'`) é só trilha — o `resolvido` já comunica o valor. O dispatcher
 * recusa antes de qualquer consulta (o `em` nem é tocado).
 */
describe('resolverJobs — custo informado ao resolver (D-043)', () => {
  it('não gera e-mail nem webhook para origem = resolucao', async () => {
    const findOne = vi.fn();
    const em = { findOne } as unknown as EntityManager;
    const jobs = await resolverJobs(em, {
      tipo: 'custo_final_definido',
      chamado_id: 'c-1',
      ator_id: 'op-1',
      dados: { de: null, para: 150, origem: 'resolucao' },
    });
    expect(jobs).toEqual([]);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('complexidade (interna) também não notifica', async () => {
    const findOne = vi.fn();
    const em = { findOne } as unknown as EntityManager;
    expect(
      await resolverJobs(em, { tipo: 'complexidade_alterada', chamado_id: 'c-1', ator_id: 'op-1' }),
    ).toEqual([]);
    expect(findOne).not.toHaveBeenCalled();
  });
});
