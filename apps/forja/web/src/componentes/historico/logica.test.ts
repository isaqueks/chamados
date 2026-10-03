import { describe, expect, it } from 'vitest';
import type { WorktreeDto } from '@comum/dto';
import {
  acoesWorktree,
  filtrosHistorico,
  formatarDuracao,
  formatarTaxa,
  ordenarWorktrees,
  podeApagarDados,
  resumoWorktrees,
} from './logica';

function wt(p: Partial<WorktreeDto>): WorktreeDto {
  return {
    caminho: '/d/w',
    branch: 'forja/chamado-1-x',
    execucao_id: 'e1',
    numero: 1,
    estado_execucao: 'implementando',
    tamanho_bytes: 100,
    ultima_atividade: null,
    orfa: false,
    prunable: false,
    projeto_id: 'p1',
    ...p,
  };
}

describe('histórico (06 §4.11)', () => {
  const agora = new Date('2026-10-02T12:00:00.000Z');

  it('filtros: período vira `de`; todos os resultados = sem filtro', () => {
    expect(
      filtrosHistorico({
        projetoId: 'p1',
        periodo: '7d',
        resultados: new Set(['concluido', 'descartado', 'cancelado']),
        agora,
      }),
    ).toEqual({ projeto_id: 'p1', de: '2026-09-25T12:00:00.000Z' });
    expect(
      filtrosHistorico({
        projetoId: null,
        periodo: 'tudo',
        resultados: new Set(['cancelado', 'concluido']),
        agora,
      }),
    ).toEqual({ resultado: ['concluido', 'cancelado'] });
  });

  it('apagar dados só em execução encerrada', () => {
    expect(podeApagarDados('concluido')).toBe(true);
    expect(podeApagarDados('descartado')).toBe(true);
    expect(podeApagarDados('aguardando_deploy')).toBe(false);
    expect(podeApagarDados(null)).toBe(false);
  });

  it('taxas e durações legíveis, sem arredondar para cima', () => {
    expect(formatarTaxa(0.629)).toBe('62%');
    expect(formatarTaxa(null)).toBe('—');
    expect(formatarDuracao(30_000)).toBe('< 1 min');
    expect(formatarDuracao(5_400_000)).toBe('1 h 30 min');
    expect(formatarDuracao(7_200_000)).toBe('2 h');
  });
});

describe('worktrees (06 §4.11)', () => {
  it('órfãs primeiro, depois as maiores; resumo de bytes órfãos', () => {
    const lista = [
      wt({ caminho: 'a', tamanho_bytes: 10 }),
      wt({ caminho: 'b', orfa: true, tamanho_bytes: 5 }),
      wt({ caminho: 'c', tamanho_bytes: 50 }),
      wt({ caminho: 'd', orfa: true, tamanho_bytes: 7 }),
    ];
    expect(ordenarWorktrees(lista).map((w) => w.caminho)).toEqual(['d', 'b', 'c', 'a']);
    expect(resumoWorktrees(lista)).toEqual({ total: 4, orfas: 2, bytesOrfas: 12 });
  });

  it('ações: retomar só com execução ativa; limpar só fora de execução ativa', () => {
    expect(acoesWorktree(wt({}))).toEqual({ abrirTerminal: true, retomar: true, limpar: false });
    expect(acoesWorktree(wt({ estado_execucao: 'concluido', orfa: true }))).toEqual({
      abrirTerminal: true,
      retomar: false,
      limpar: true,
    });
    expect(
      acoesWorktree(wt({ execucao_id: null, estado_execucao: null, projeto_id: null })),
    ).toEqual({
      abrirTerminal: false,
      retomar: false,
      limpar: true,
    });
  });
});
