import { describe, expect, it } from 'vitest';
import type { ControleTerminalServidor } from '../../comum/dto';
import { ErroSessaoOcupada, LocksSessaoMemoria } from '../processos/lock-sessao';
import type { EscadaSinais } from '../processos/supervisor';
import type { FabricaPty, FimPty, OpcoesPty, ProcessoPty } from './pty';
import {
  ErroTerminal,
  GerenteSessoesTerminal,
  ScrollbackPty,
  type ClienteTerminal,
  type EventoSessaoTerminal,
} from './sessoes';

const SESSION = '3f2a9c1e-0b7d-4e2a-9f10-5c6d7e8f9a0b';
const ESCADA_CURTA: EscadaSinais = [
  { sinal: 'SIGHUP', esperaMs: 20 },
  { sinal: 'SIGTERM', esperaMs: 20 },
  { sinal: 'SIGKILL', esperaMs: 20 },
];

class PtyFalso implements ProcessoPty {
  static proximoPid = 5000;
  readonly pid = (PtyFalso.proximoPid += 1);
  escritos: string[] = [];
  sinais: NodeJS.Signals[] = [];
  tamanho: [number, number] | null = null;
  /** Sinais que matam este falso (os outros são ignorados). */
  morreCom: ReadonlySet<NodeJS.Signals> = new Set(['SIGHUP', 'SIGTERM', 'SIGKILL']);
  saiComExit = true;
  private dados = new Set<(d: string) => void>();
  private saida = new Set<(f: FimPty) => void>();
  private morto = false;

  constructor(readonly opcoes: OpcoesPty) {}
  aoDados(fn: (d: string) => void) {
    this.dados.add(fn);
    return () => this.dados.delete(fn);
  }
  aoSair(fn: (f: FimPty) => void) {
    this.saida.add(fn);
    return () => this.saida.delete(fn);
  }
  escrever(d: string): void {
    this.escritos.push(d);
    if (d === '/exit\r' && this.saiComExit) this.sair({ codigo: 0, sinal: null });
  }
  redimensionar(c: number, l: number): void {
    this.tamanho = [c, l];
  }
  sinalizar(s: NodeJS.Signals): void {
    this.sinais.push(s);
    if (this.morreCom.has(s)) this.sair({ codigo: null, sinal: s });
  }
  emitir(d: string): void {
    for (const fn of this.dados) fn(d);
  }
  sair(f: FimPty): void {
    if (this.morto) return;
    this.morto = true;
    queueMicrotask(() => {
      for (const fn of this.saida) fn(f);
    });
  }
}

function montar(opcoes: Partial<ConstructorParameters<typeof GerenteSessoesTerminal>[0]> = {}) {
  const ptys: PtyFalso[] = [];
  const eventos: EventoSessaoTerminal[] = [];
  const fabrica: FabricaPty = (o) => {
    const p = new PtyFalso(o);
    ptys.push(p);
    return p;
  };
  const locks = new LocksSessaoMemoria();
  const gerente = new GerenteSessoesTerminal({
    locks,
    fabrica,
    escada: ESCADA_CURTA,
    aoEvento: (e) => eventos.push(e),
    ambienteOrigem: { PATH: '/bin', HOME: '/h' },
    ...opcoes,
  });
  return { gerente, ptys, eventos, locks };
}

class ClienteFalso implements ClienteTerminal {
  log: (string | ControleTerminalServidor)[] = [];
  enviarBytes(d: string): void {
    this.log.push(d);
  }
  enviarControle(m: ControleTerminalServidor): void {
    this.log.push(m);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ScrollbackPty', () => {
  it('guarda só os últimos N bytes (UTF-8)', () => {
    const s = new ScrollbackPty(10);
    s.acrescentar('0123456');
    s.acrescentar('789abc');
    expect(s.conteudo()).toBe('3456789abc');
    expect(s.tamanhoBytes).toBe(10);
    s.acrescentar('x'.repeat(25));
    expect(s.conteudo()).toBe('x'.repeat(10));
  });
});

describe('GerenteSessoesTerminal (01 §11, 03 §10)', () => {
  it('livre: `claude` sem args, cwd escolhido, TERM do PTY', () => {
    const { gerente, ptys, eventos } = montar();
    const info = gerente.abrirLivre({ cwd: '/repo', titulo: 'repo' });
    expect(ptys[0]!.opcoes).toMatchObject({ comando: 'claude', args: [], cwd: '/repo' });
    expect(ptys[0]!.opcoes.env.TERM).toBe('xterm-256color');
    expect(info).toMatchObject({ tipo: 'livre', viva: true, pid: ptys[0]!.pid });
    expect(eventos[0]).toMatchObject({ tipo: 'aberta', reaberta: false });
  });

  it('assumir prende o lock ANTES do spawn; etapa rodando na sessão → recusa', () => {
    const { gerente, locks, ptys } = montar();
    locks.adquirir(SESSION, { tipo: 'etapa', etapa_id: 'e1' });
    const base = {
      cwd: '/wt',
      titulo: '#120 · implementar (assumida)',
      execucao_id: 'x1',
      etapa_id: 'e1',
      session_id: SESSION,
      settings: '/d/settings.2.json',
      modelo: 'm',
    };
    expect(() => gerente.assumir(base)).toThrow(ErroSessaoOcupada);
    expect(ptys).toHaveLength(0);
    locks.liberar(SESSION, { tipo: 'etapa', etapa_id: 'e1' });
    const info = gerente.assumir(base);
    expect(locks.dono(SESSION)).toEqual({ tipo: 'terminal', sessao_terminal_id: info.id });
    expect(ptys[0]!.opcoes.args).toContain('--resume');
    expect(ptys[0]!.opcoes.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    // Segunda aba na mesma sessão: proibido (1 processo por session_id).
    expect(() => gerente.assumir(base)).toThrow(ErroSessaoOcupada);
  });

  it('teto de PTYs vivos', () => {
    const { gerente } = montar({ limite: 2 });
    gerente.abrirLivre({ cwd: '/a', titulo: 'a' });
    gerente.abrirLivre({ cwd: '/b', titulo: 'b' });
    expect(() => gerente.abrirLivre({ cwd: '/c', titulo: 'c' })).toThrow(ErroTerminal);
  });

  it('anexar: scrollback primeiro, depois ao vivo; entrada e resize chegam ao PTY', () => {
    const { gerente, ptys } = montar();
    const { id } = gerente.abrirLivre({ cwd: '/r', titulo: 'r' });
    ptys[0]!.emitir('antes ');
    const c = new ClienteFalso();
    gerente.anexar(id, c);
    ptys[0]!.emitir('depois');
    expect(c.log).toEqual([
      { tipo: 'scrollback_inicio' },
      'antes ',
      { tipo: 'scrollback_fim' },
      'depois',
    ]);
    gerente.escrever(id, 'ls\r');
    gerente.redimensionar(id, 90, 20);
    expect(ptys[0]!.escritos).toEqual(['ls\r']);
    expect(ptys[0]!.tamanho).toEqual([90, 20]);
  });

  it('saída do processo avisa o cliente; [Reabrir] faz novo processo na mesma aba', async () => {
    const { gerente, ptys, eventos } = montar();
    const { id } = gerente.abrirLivre({ cwd: '/r', titulo: 'r' });
    const c = new ClienteFalso();
    gerente.anexar(id, c);
    ptys[0]!.sair({ codigo: 0, sinal: null });
    await tick();
    expect(c.log.at(-1)).toEqual({ tipo: 'encerrado', codigo: 0, sinal: null });
    expect(gerente.obter(id)).toMatchObject({ viva: false, pid: null });
    expect(eventos.map((e) => e.tipo)).toEqual(['aberta', 'processo_saiu']);
    gerente.reabrir(id);
    expect(ptys).toHaveLength(2);
    expect(() => gerente.reabrir(id)).toThrow(/rodando/);
  });

  it('sem cliente, o PTY morre após a carência (05 §7.2); reanexar cancela', async () => {
    const { gerente, ptys } = montar({ carenciaSemClienteMs: 30 });
    const a = gerente.abrirLivre({ cwd: '/r', titulo: 'r' });
    const b = gerente.abrirLivre({ cwd: '/r', titulo: 'r' });
    gerente.anexar(b.id, new ClienteFalso());
    await new Promise((r) => setTimeout(r, 80));
    expect(ptys[0]!.sinais[0]).toBe('SIGHUP');
    expect(gerente.obter(a.id)?.viva).toBe(false);
    expect(gerente.obter(b.id)?.viva).toBe(true);
  });

  it('devolver: /exit → sai sozinho → lock liberado e evento devolvida', async () => {
    const { gerente, locks, ptys, eventos } = montar();
    const { id } = gerente.assumir({
      cwd: '/wt',
      titulo: 't',
      execucao_id: 'x',
      etapa_id: 'e',
      session_id: SESSION,
      settings: '/s.json',
      modelo: 'm',
    });
    const r = await gerente.devolver(id);
    expect(ptys[0]!.escritos).toEqual(['/exit\r']);
    expect(r).toMatchObject({ forcado: false, fim: { codigo: 0 } });
    expect(locks.dono(SESSION)).toBeNull();
    expect(eventos.at(-1)).toMatchObject({ tipo: 'devolvida', forcado: false });
    await expect(gerente.devolver(id)).rejects.toThrow(/devolvida/);
    expect(() => gerente.reabrir(id)).toThrow(/devolvida/);
  });

  it('devolver com a TUI travada: timeout → escada (forcado)', async () => {
    const { gerente, ptys, locks } = montar();
    const { id } = gerente.assumir({
      cwd: '/wt',
      titulo: 't',
      execucao_id: 'x',
      etapa_id: 'e',
      session_id: SESSION,
      settings: '/s.json',
      modelo: 'm',
    });
    ptys[0]!.saiComExit = false;
    ptys[0]!.morreCom = new Set(['SIGTERM']);
    const r = await gerente.devolver(id, { timeoutMs: 20 });
    expect(r.forcado).toBe(true);
    expect(ptys[0]!.sinais).toEqual(['SIGHUP', 'SIGTERM']);
    expect(locks.dono(SESSION)).toBeNull();
  });

  it('assumida com processo morto continua com lock até devolver; fechar exige liberarLock', async () => {
    const { gerente, locks, ptys } = montar();
    const { id } = gerente.assumir({
      cwd: '/wt',
      titulo: 't',
      execucao_id: 'x',
      etapa_id: 'e',
      session_id: SESSION,
      settings: '/s.json',
      modelo: 'm',
    });
    await gerente.encerrar(id);
    expect(ptys[0]!.sinais).toEqual(['SIGHUP']);
    expect(locks.dono(SESSION)).not.toBeNull();
    await expect(gerente.fechar(id)).rejects.toThrow(ErroTerminal);
    await gerente.fechar(id, { liberarLock: true });
    expect(locks.dono(SESSION)).toBeNull();
    expect(gerente.listar()).toEqual([]);
  });

  it('sessoesProtegidas lista os pids vivos (varredura do supervisor os poupa)', () => {
    const { gerente, ptys } = montar();
    gerente.abrirLivre({ cwd: '/r', titulo: 'r' });
    expect([...gerente.sessoesProtegidas()]).toEqual([ptys[0]!.pid]);
  });
});

describe('GerenteSessoesTerminal com node-pty real (sem claude)', () => {
  it('abre /bin/sh no lugar do claude, ecoa e encerra', async () => {
    const eventos: EventoSessaoTerminal[] = [];
    const gerente = new GerenteSessoesTerminal({
      locks: new LocksSessaoMemoria(),
      comandoClaude: '/bin/sh',
      aoEvento: (e) => eventos.push(e),
    });
    const { id } = gerente.abrirLivre({ cwd: process.cwd(), titulo: 'sh' });
    const c = new ClienteFalso();
    gerente.anexar(id, c);
    gerente.escrever(id, 'echo "ok-$((20+22))"; exit\r');
    const limite = Date.now() + 5000;
    while (!eventos.some((e) => e.tipo === 'processo_saiu') && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(c.log.filter((x) => typeof x === 'string').join('')).toContain('ok-42');
    expect(gerente.obter(id)?.fim?.codigo).toBe(0);
  });

  it('diálogo de confiança da pasta: detecta (com ANSI partido) e, se a TUI sai com 1, orienta no terminal', async () => {
    const { gerente, ptys, eventos } = montar();
    const info = gerente.assumir({
      session_id: SESSION,
      settings: '/d/settings.3.json',
      modelo: 'claude-x',
      cwd: '/wt',
      titulo: '#12',
      execucao_id: 'e1',
      etapa_id: 'et1',
    });
    const cliente = new ClienteFalso();
    gerente.anexar(info.id, cliente);
    const pty = ptys[0]!;
    pty.emitir('Accessing workspace:\r\n\x1b[1m❯ No, exit\x1b[22m\r\n  Yes, I tr');
    pty.emitir('\x1b[2Must this folder\r\n');
    pty.emitir('Yes, I trust this folder'); // repintura: um evento só
    expect(eventos.filter((e) => e.tipo === 'confianca_pasta')).toHaveLength(1);
    // Nada é respondido pelo app.
    expect(pty.escritos).toEqual([]);

    pty.sair({ codigo: 1, sinal: null });
    await new Promise((r) => setTimeout(r, 0));
    const saiu = eventos.find((e) => e.tipo === 'processo_saiu');
    expect(saiu?.tipo === 'processo_saiu' && saiu.confianca_recusada).toBe(true);
    expect(
      cliente.log.some((l) => typeof l === 'string' && l.includes('Yes, I trust this folder')),
    ).toBe(true);
  });

  it('sem diálogo de confiança, a saída com código 1 não escreve aviso', async () => {
    const { gerente, ptys, eventos } = montar();
    const info = gerente.abrirLivre({ cwd: '/repo', titulo: 'livre' });
    const cliente = new ClienteFalso();
    gerente.anexar(info.id, cliente);
    ptys[0]!.emitir('olá\r\n');
    ptys[0]!.sair({ codigo: 1, sinal: null });
    await new Promise((r) => setTimeout(r, 0));
    const saiu = eventos.find((e) => e.tipo === 'processo_saiu');
    expect(saiu?.tipo === 'processo_saiu' && saiu.confianca_recusada).toBeFalsy();
    expect(cliente.log.some((l) => typeof l === 'string' && l.includes('[Forja]'))).toBe(false);
  });
});
