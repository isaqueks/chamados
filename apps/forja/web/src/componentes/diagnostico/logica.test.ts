import { describe, expect, it } from 'vitest';
import type { ItemDiagnosticoDto } from '@comum/dto';
import {
  itemBloqueante,
  ordenarItens,
  prerequisitosModoReforcado,
  resumirDiagnostico,
  situacaoCli,
} from './logica';

function item(
  codigo: string,
  estado: ItemDiagnosticoDto['estado'],
  bloqueia: ItemDiagnosticoDto['bloqueia'],
): ItemDiagnosticoDto {
  return { codigo, titulo: codigo, estado, detalhe: '', bloqueia, acao: null };
}

const itens = [
  item('gh', 'aviso', null),
  item('git', 'ok', 'pipeline'),
  item('socat', 'erro', 'modo_reforcado'),
  item('auth', 'erro', 'pipeline'),
  item('chamados', 'erro', 'execucoes'),
  item('pty', 'pendente', 'terminal'),
];

describe('diagnóstico (06 §4.10)', () => {
  it('ordena por severidade e depois pelo alcance do bloqueio', () => {
    expect(ordenarItens(itens).map((i) => i.codigo)).toEqual([
      'auth',
      'chamados',
      'socat',
      'gh',
      'pty',
      'git',
    ]);
  });

  it('bloqueante = erro em algo que bloqueia pipeline ou execuções', () => {
    expect(itens.filter(itemBloqueante).map((i) => i.codigo)).toEqual(['auth', 'chamados']);
    expect(resumirDiagnostico(itens)).toEqual({
      bloqueantes: 2,
      erros: 3,
      avisos: 1,
      ok: 1,
      pendentes: 1,
    });
  });

  it('situação da CLI: igual, diverge com/sem smoke, ausente', () => {
    expect(situacaoCli({ encontrada: '2.4.1', fixada: '2.4.1', smoke_aprovado: true })).toBe(
      'igual',
    );
    expect(situacaoCli({ encontrada: '2.5.0', fixada: '2.4.1', smoke_aprovado: false })).toBe(
      'diverge_bloqueia',
    );
    expect(situacaoCli({ encontrada: '2.5.0', fixada: '2.4.1', smoke_aprovado: true })).toBe(
      'diverge_aprovada',
    );
    expect(situacaoCli({ encontrada: null, fixada: '2.4.1', smoke_aprovado: false })).toBe(
      'ausente',
    );
  });

  it('pré-requisitos do modo reforçado: só liga com todos ok', () => {
    expect(prerequisitosModoReforcado(itens)).toMatchObject({ todosOk: false, conhecido: true });
    expect(prerequisitosModoReforcado([item('bwrap', 'ok', 'modo_reforcado')]).todosOk).toBe(true);
    expect(prerequisitosModoReforcado([])).toMatchObject({ todosOk: false, conhecido: false });
  });
});
