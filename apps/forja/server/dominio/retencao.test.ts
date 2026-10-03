import { describe, expect, it } from 'vitest';
import { configResolvidaPadrao } from '../../comum/config-projeto';
import type { EstadoExecucao } from '../../comum/estados';
import { planejarRetencao, type EntradaRetencao } from './retencao';

/** Retenção (02 §9): o plano puro decide o que expira; nada sem confirmação nas paradas. */

const config = configResolvidaPadrao({
  dir: '/repo',
  remoto: 'origin',
  branch_destino: 'main',
  prefixo_branch: 'forja/',
});
const AGORA = new Date('2026-12-31T00:00:00.000Z');
const dias = (n: number) => new Date(AGORA.getTime() - n * 86_400_000).toISOString();

function exec(
  id: string,
  estado: EstadoExecucao,
  p: Partial<EntradaRetencao['execucoes'][number]> = {},
) {
  return {
    id,
    numero: Number(id.replace(/\D/g, '')) || 1,
    estado,
    worktree_dir: `/dados/worktrees/erp/${id}`,
    branch: `forja/chamado-${id}`,
    sha_merge: null,
    concluido_em: dias(1),
    atualizado_em: dias(1),
    config_snapshot: config,
    ...p,
  };
}

function plano(execucoes: EntradaRetencao['execucoes'], existentes?: Set<string>) {
  return planejarRetencao({
    execucoes,
    repoDir: () => '/repo',
    dirExecucao: (id) => `/dados/execucoes/${id}`,
    existe: (c) => (existentes ? existentes.has(c) : true),
    agora: AGORA,
  });
}

describe('planejarRetencao', () => {
  it('concluído: worktree sai já (branch mantida); evidências só depois de 90 dias', () => {
    const p = plano([exec('e1', 'concluido', { sha_merge: 'abc' })]);
    expect(p.remover_worktrees).toEqual([
      expect.objectContaining({ execucao_id: 'e1', apagar_branch: null }),
    ]);
    expect(p.apagar_evidencias).toEqual([]);
    const velho = plano([exec('e2', 'concluido', { concluido_em: dias(91) })]);
    expect(velho.apagar_evidencias.map((x) => x.dir)).toEqual(['/dados/execucoes/e2/evidencias']);
    expect(velho.apagar_brutos.map((x) => x.dir)).toEqual(['/dados/execucoes/e2/etapas']);
  });

  it('descartado: worktree só depois do prazo e a branch só se nunca foi mergeada', () => {
    expect(plano([exec('e3', 'descartado')]).remover_worktrees).toEqual([]);
    const p = plano([exec('e3', 'descartado', { concluido_em: dias(8) })]);
    expect(p.remover_worktrees[0]?.apagar_branch).toBe('forja/chamado-e3');
    // Prints de execução descartada saem logo (02 §9).
    expect(p.apagar_evidencias).toHaveLength(1);
  });

  it('falhou/precisa_humano parada: nunca automático, só pede confirmação', () => {
    const p = plano([exec('e4', 'precisa_humano', { atualizado_em: dias(10) })]);
    expect(p.remover_worktrees).toEqual([]);
    expect(p.confirmar.map((x) => x.execucao_id)).toEqual(['e4']);
  });

  it('execução ativa não perde nada; uso_assinatura tem corte de 30 dias', () => {
    const p = plano([exec('e5', 'implementando', { concluido_em: null, atualizado_em: dias(30) })]);
    expect([p.remover_worktrees, p.apagar_evidencias, p.apagar_brutos, p.confirmar]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(p.uso_antes_de).toBe(dias(30));
  });

  it('worktree que não existe mais não entra', () => {
    expect(plano([exec('e6', 'concluido')], new Set()).remover_worktrees).toEqual([]);
  });
});
