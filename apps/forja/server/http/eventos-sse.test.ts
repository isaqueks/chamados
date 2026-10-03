import { describe, expect, it } from 'vitest';
import type { EventoForja } from '../../comum/protocolo-eventos';
import { ClienteSse, formatarEventoSse, interpretarUltimoId } from './eventos-sse';

const evento: EventoForja = {
  seq: 7,
  em: '2026-10-02T12:00:00.000Z',
  execucao_id: null,
  etapa_id: null,
  tipo: 'cli.alerta',
  nivel: 'aviso',
  resumo: 'linha\ncom quebra',
  dados: { codigo: 'x', bloqueante: false },
};

class SaidaFalsa {
  escritos: string[] = [];
  aceita = true;
  finalizada = false;
  private drains: (() => void)[] = [];
  write(chunk: string): boolean {
    this.escritos.push(chunk);
    return this.aceita;
  }
  once(_e: 'drain', fn: () => void): void {
    this.drains.push(fn);
  }
  end(): void {
    this.finalizada = true;
  }
  drenar(): void {
    this.aceita = true;
    const fns = this.drains;
    this.drains = [];
    for (const fn of fns) fn();
  }
}

describe('SSE (01 §8.1)', () => {
  it('formata com id: seq e JSON numa linha só', () => {
    const texto = formatarEventoSse(evento);
    expect(texto.startsWith('id: 7\ndata: ')).toBe(true);
    expect(texto.endsWith('\n\n')).toBe(true);
    expect(texto.split('\n')).toHaveLength(4);
    expect(JSON.parse(texto.split('\n')[1]!.slice(6))).toEqual(evento);
  });

  it('interpreta Last-Event-ID só quando é inteiro não negativo', () => {
    expect(interpretarUltimoId('42')).toBe(42);
    expect(interpretarUltimoId(' 0 ')).toBe(0);
    expect(interpretarUltimoId(['5'])).toBe(5);
    expect(interpretarUltimoId('-1')).toBeNull();
    expect(interpretarUltimoId('abc')).toBeNull();
    expect(interpretarUltimoId(undefined)).toBeNull();
    expect(interpretarUltimoId('1e3')).toBeNull();
  });

  it('cliente lento acumula até o limite e então estoura', () => {
    const saida = new SaidaFalsa();
    let estourou = false;
    const cliente = new ClienteSse(saida, 2, () => {
      estourou = true;
    });
    saida.aceita = false;
    cliente.enviar('a');
    cliente.enviar('b');
    cliente.enviar('c');
    expect(estourou).toBe(false);
    cliente.enviar('d');
    expect(estourou).toBe(true);
  });

  it('após drain reenvia o acumulado em ordem', () => {
    const saida = new SaidaFalsa();
    const cliente = new ClienteSse(saida, 10, () => {});
    saida.aceita = false;
    cliente.enviar('a');
    cliente.enviar('b');
    cliente.enviar('c');
    saida.drenar();
    expect(saida.escritos).toEqual(['a', 'b', 'c']);
  });

  it('encerrar escreve a última mensagem, fecha e ignora envios depois', () => {
    const saida = new SaidaFalsa();
    const cliente = new ClienteSse(saida, 10, () => {});
    cliente.encerrar('tchau');
    cliente.enviar('depois');
    expect(saida.escritos).toEqual(['tchau']);
    expect(saida.finalizada).toBe(true);
    expect(cliente.fechado).toBe(true);
  });
});
