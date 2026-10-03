import { describe, expect, it } from 'vitest';
import type { EventoForja, NovoEventoForja } from '../../comum/protocolo-eventos';
import { AnelLimitado, FilaCliente, type SaidaCliente } from './anel';
import { BarramentoEventos, filtroCanalExecucao, filtroCanalGlobal, LACUNA } from './barramento';
import { MARCA_REDIGIDO, Redator } from './normalizador';
import { PersistenciaEventosMemoria } from './persistencia';

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

function ferramenta(execucao_id: string): NovoEventoForja {
  return {
    execucao_id,
    etapa_id: 'e',
    tipo: 'agente.ferramenta',
    nivel: 'info',
    resumo: 'Bash',
    dados: {
      tool_use_id: 't',
      ferramenta: 'Bash',
      resumo_entrada: 'npm test',
      subagente: null,
      papel_agente: 'implementador',
      parent_tool_use_id: null,
    },
  };
}

class SaidaFalsa implements SaidaCliente<EventoForja> {
  recebidos: EventoForja[] = [];
  aceita = true;
  private drenos: (() => void)[] = [];
  escrever(e: EventoForja): boolean {
    this.recebidos.push(e);
    return this.aceita;
  }
  aoDrenar(fn: () => void): void {
    this.drenos.push(fn);
  }
  drenar(): void {
    this.aceita = true;
    const fns = this.drenos;
    this.drenos = [];
    for (const fn of fns) fn();
  }
}

describe('AnelLimitado / FilaCliente (01 §8.1)', () => {
  it('anel descarta o mais antigo e itera em ordem', () => {
    const a = new AnelLimitado<number>(3);
    for (const n of [1, 2, 3]) a.push(n);
    expect(a.push(4)).toBe(1);
    expect(a.paraArray()).toEqual([2, 3, 4]);
    expect(a.shift()).toBe(2);
    a.push(5);
    a.push(6);
    expect([a.primeiro(), a.ultimo(), a.length]).toEqual([4, 6, 3]);
    expect(() => new AnelLimitado(0)).toThrow(RangeError);
  });

  it('fila do cliente: escreve direto, acumula na espera, drena em ordem', () => {
    const s: number[] = [];
    let aceita = true;
    let dreno: () => void = () => {};
    const fila = new FilaCliente<number>(
      {
        escrever: (n) => (s.push(n), aceita),
        aoDrenar: (fn) => (dreno = fn),
      },
      10,
      () => {},
    );
    fila.enviar(1);
    aceita = false;
    fila.enviar(2); // socket cheio
    fila.enviar(3);
    fila.enviar(4);
    expect(s).toEqual([1, 2]);
    expect(fila.emEspera).toBe(2);
    aceita = true;
    dreno();
    expect(s).toEqual([1, 2, 3, 4]);
  });
});

describe('BarramentoEventos com persistência (02 §4.8)', () => {
  it('o seq vem do banco e continua após "reboot"', () => {
    const banco = new PersistenciaEventosMemoria(41);
    const b = new BarramentoEventos({ persistencia: banco });
    expect(b.ultimoSeq).toBe(41);
    const e = b.publicar(alerta('a'), { origem: 'cli', linha_bruta: 7 });
    expect(e.seq).toBe(42);
    expect(banco.metaDe(42)).toEqual({ origem: 'cli', linha_bruta: 7 });
    expect(new BarramentoEventos({ persistencia: banco }).ultimoSeq).toBe(42);
  });

  it('falha ao gravar: ninguém recebe o evento (a UI só vê o persistido)', () => {
    const banco = new PersistenciaEventosMemoria();
    banco.gravar = () => {
      throw new Error('disco cheio');
    };
    const b = new BarramentoEventos({ persistencia: banco });
    const vistos: number[] = [];
    b.assinar((e) => vistos.push(e.seq));
    expect(() => b.publicar(alerta('a'))).toThrow('disco cheio');
    expect(vistos).toEqual([]);
  });

  it('replay além do anel cai no banco; acima do teto vira LACUNA', () => {
    const banco = new PersistenciaEventosMemoria();
    const b = new BarramentoEventos({ persistencia: banco, capacidade: 2, limiteReplay: 3 });
    for (const c of ['a', 'b', 'c', 'd', 'e']) b.publicar(alerta(c));
    const r = b.desde(2);
    expect(r === LACUNA ? r : r.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(b.desde(1)).toBe(LACUNA); // 4 eventos > teto 3
    const sem = new BarramentoEventos({ capacidade: 2 });
    for (const c of ['a', 'b', 'c']) sem.publicar(alerta(c));
    expect(sem.desde(0)).toBe(LACUNA);
  });

  it('enxuga e redige antes de numerar (nada de segredo no SQLite nem no SSE)', () => {
    const banco = new PersistenciaEventosMemoria();
    const b = new BarramentoEventos({
      persistencia: banco,
      redator: new Redator(['valor-do-env']),
    });
    const e = b.publicar(alerta('leu valor-do-env'));
    expect(e.resumo).toBe(`leu ${MARCA_REDIGIDO}`);
    expect(JSON.stringify(banco.desde(0))).not.toContain('valor-do-env');
  });

  it('assinatura filtrada por execução e filtros de canal', () => {
    const b = new BarramentoEventos();
    const daX: number[] = [];
    b.assinar((e) => daX.push(e.seq), filtroCanalExecucao('x'));
    b.publicar(ferramenta('x'));
    b.publicar(ferramenta('y'));
    const global = b.publicar(alerta('g'));
    expect(daX).toEqual([1]);
    expect(filtroCanalGlobal(global)).toBe(true);
  });
});

describe('conectarCliente: buffer em anel e sistema.recarregar', () => {
  it('replay a partir do Last-Event-ID e depois ao vivo, filtrado', () => {
    const b = new BarramentoEventos();
    b.publicar(ferramenta('x'));
    b.publicar(ferramenta('y'));
    b.publicar(ferramenta('x'));
    const saida = new SaidaFalsa();
    b.conectarCliente({
      saida,
      filtro: filtroCanalExecucao('x'),
      ultimoSeq: 1,
      aoEstourar: () => {},
    });
    b.publicar(ferramenta('x'));
    expect(saida.recebidos.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('lacuna no histórico → recarregar(lacuna_no_historico) e segue ao vivo', () => {
    const b = new BarramentoEventos({ capacidade: 1 });
    b.publicar(alerta('a'));
    b.publicar(alerta('b'));
    const saida = new SaidaFalsa();
    b.conectarCliente({ saida, ultimoSeq: 0, aoEstourar: () => {} });
    expect(saida.recebidos[0]).toMatchObject({
      tipo: 'sistema.recarregar',
      dados: { motivo: 'lacuna_no_historico' },
    });
  });

  it('cliente lento: o publicador não bloqueia; estoura → recarregar(cliente_lento) e sai', () => {
    const b = new BarramentoEventos();
    const lento = new SaidaFalsa();
    lento.aceita = false;
    const rapido = new SaidaFalsa();
    let recarga: EventoForja | null = null;
    const conexao = b.conectarCliente({
      saida: lento,
      capacidade: 3,
      aoEstourar: (e) => (recarga = e),
    });
    b.conectarCliente({ saida: rapido, aoEstourar: () => {} });
    for (let i = 0; i < 10; i += 1) b.publicar(alerta(`e${i}`));
    expect(rapido.recebidos).toHaveLength(10);
    expect(lento.recebidos).toHaveLength(1); // o 1º foi escrito; o socket encheu
    expect(conexao.fila.estourou).toBe(true);
    expect(recarga).toMatchObject({
      tipo: 'sistema.recarregar',
      seq: 5,
      dados: { motivo: 'cliente_lento' },
    });
    expect(b.totalAssinantes).toBe(1);
  });

  it('cancelar desliga a assinatura', () => {
    const b = new BarramentoEventos();
    const saida = new SaidaFalsa();
    const c = b.conectarCliente({ saida, aoEstourar: () => {} });
    c.cancelar();
    b.publicar(alerta('a'));
    expect(saida.recebidos).toEqual([]);
    expect(b.totalAssinantes).toBe(0);
  });
});
