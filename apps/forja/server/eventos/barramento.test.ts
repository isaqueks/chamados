import { describe, expect, it } from 'vitest';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import { BarramentoEventos, LACUNA } from './barramento';

function alerta(codigo: string, execucao_id: string | null = null): NovoEventoForja {
  return {
    execucao_id,
    etapa_id: null,
    tipo: 'cli.alerta',
    nivel: 'aviso',
    resumo: codigo,
    dados: { codigo, bloqueante: false },
  };
}

describe('BarramentoEventos', () => {
  it('atribui seq monotônico e entrega aos assinantes', () => {
    const b = new BarramentoEventos({ agora: () => new Date('2026-10-02T12:00:00.000Z') });
    const recebidos: number[] = [];
    const cancelar = b.assinar((e) => recebidos.push(e.seq));
    const e1 = b.publicar(alerta('a'));
    const e2 = b.publicar(alerta('b'));
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    expect(e1.em).toBe('2026-10-02T12:00:00.000Z');
    cancelar();
    b.publicar(alerta('c'));
    expect(recebidos).toEqual([1, 2]);
    expect(b.ultimoSeq).toBe(3);
  });

  it('continua a numeração a partir do seq persistido', () => {
    const b = new BarramentoEventos({ seqInicial: 41 });
    expect(b.publicar(alerta('x')).seq).toBe(42);
  });

  it('um assinante que lança não impede os outros nem quem publica', () => {
    const b = new BarramentoEventos();
    const ok: number[] = [];
    b.assinar(() => {
      throw new Error('quebrado');
    });
    b.assinar((e) => ok.push(e.seq));
    expect(() => b.publicar(alerta('a'))).not.toThrow();
    expect(ok).toEqual([1]);
  });

  it('desde(seq) reenvia exatamente o que faltou, sem duplicata (01 §14 A6)', () => {
    const b = new BarramentoEventos();
    for (const c of ['a', 'b', 'c', 'd']) b.publicar(alerta(c));
    const faltou = b.desde(2);
    expect(faltou !== LACUNA && faltou.map((e) => e.seq)).toEqual([3, 4]);
    expect(b.desde(4)).toEqual([]);
    expect(b.desde(99)).toEqual([]);
  });

  it('desde aplica o filtro do canal', () => {
    const b = new BarramentoEventos();
    b.publicar(alerta('a', 'x'));
    b.publicar(alerta('b', 'y'));
    b.publicar(alerta('c', 'x'));
    const r = b.desde(0, (e) => e.execucao_id === 'x');
    expect(r !== LACUNA && r.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('devolve LACUNA quando o anel já descartou o pedido', () => {
    const b = new BarramentoEventos({ capacidade: 2 });
    for (const c of ['a', 'b', 'c', 'd']) b.publicar(alerta(c));
    expect(b.desde(0)).toBe(LACUNA);
    expect(b.desde(1)).toBe(LACUNA);
    const r = b.desde(2);
    expect(r !== LACUNA && r.map((e) => e.seq)).toEqual([3, 4]);
  });
});
