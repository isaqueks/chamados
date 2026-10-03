import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { grupoVivo, leitorProcLinux } from './proc-linux';
import {
  encerrarGrupo,
  ErroSpawn,
  RegistroProcessosMemoria,
  Supervisor,
  type EscadaSinais,
  type ProcessoSupervisionado,
} from './supervisor';

/**
 * Supervisor com processos REAIS (`sleep`/`sh`), sem `claude` (01 §4.2): grupo
 * próprio, escada de sinais, timeout, sobras do grupo, varredura de cwd e
 * órfãos do boot. Escadas curtas para o teste não levar 20 s.
 */

const ESCADA_CURTA: EscadaSinais = [
  { sinal: 'SIGINT', esperaMs: 300 },
  { sinal: 'SIGTERM', esperaMs: 300 },
  { sinal: 'SIGKILL', esperaMs: 1000 },
];

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'forja-sup-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function coletar(p: ProcessoSupervisionado): { saida: () => string } {
  let texto = '';
  p.stdout.setEncoding('utf8').on('data', (d: string) => (texto += d));
  p.stderr.resume();
  return { saida: () => texto };
}

function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('condição não atingida');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Supervisor (01 §3.2)', () => {
  it('spawn em grupo próprio (pgid = pid), registra antes de consumir e no fim', async () => {
    const registro = new RegistroProcessosMemoria();
    const sup = new Supervisor({ registro });
    const p = await sup.iniciar({
      comando: 'sh',
      args: ['-c', 'echo ok; sleep 0.2'],
      cwd: tmp,
      env,
      rotulo: 'teste:eco',
      etapa_id: 'etapa-1',
    });
    expect(p.pgid).toBe(p.pid);
    expect(leitorProcLinux.stat(p.pid)?.pgid).toBe(p.pid);
    expect(leitorProcLinux.stat(p.pid)?.pgid).not.toBe(leitorProcLinux.stat(process.pid)?.pgid);
    expect(registro.ativos.get(p.pid)).toMatchObject({ etapa_id: 'etapa-1', comando: 'sh' });
    const { saida } = coletar(p);
    const fim = await p.fim;
    expect(saida()).toBe('ok\n');
    expect(fim).toMatchObject({ exit_code: 0, sinal: null, motivo: 'natural', escada: null });
    expect(registro.ativos.size).toBe(0);
    expect(registro.encerrados[0]?.fim.motivo).toBe('natural');
  });

  it('escreve a entrada no stdin e fecha (01 §6.1)', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'cat',
      args: [],
      cwd: tmp,
      env,
      rotulo: 'teste:cat',
      entrada: 'olá, forja',
    });
    const { saida } = coletar(p);
    await p.fim;
    expect(saida()).toBe('olá, forja');
  });

  it('comando inexistente rejeita com ErroSpawn (ENOENT)', async () => {
    const sup = new Supervisor();
    await expect(
      sup.iniciar({ comando: 'nao-existe-forja-xyz', args: [], cwd: tmp, env, rotulo: 'x' }),
    ).rejects.toMatchObject({ codigo: 'ENOENT' });
  });

  it('falha ao registrar o pid mata o filho (processo sem registro é órfão)', async () => {
    const sup = new Supervisor({
      registro: {
        aoIniciar: () => {
          throw new Error('banco travado');
        },
        aoTerminar: () => {},
      },
    });
    const erro = await sup
      .iniciar({ comando: 'sleep', args: ['30'], cwd: tmp, env, rotulo: 'x' })
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroSpawn);
    expect((erro as ErroSpawn).codigo).toBe('REGISTRO');
    await esperar(() => sup.ativos().length === 0);
  });

  it('escada: SIGINT ignorado → SIGTERM encerra o grupo', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'sh',
      args: ['-c', 'trap "" INT; echo pronto; sleep 30'],
      cwd: tmp,
      env,
      rotulo: 'teste:ignora-int',
      escada: ESCADA_CURTA,
    });
    const { saida } = coletar(p);
    await esperar(() => saida().includes('pronto')); // trap instalado antes do sinal
    const fim = await p.cancelar();
    expect(fim.motivo).toBe('cancelado');
    expect(fim.escada?.sinais).toEqual(['SIGINT', 'SIGTERM']);
    expect(fim.escada?.encerrado).toBe(true);
    expect(grupoVivo(p.pgid)).toBe(false);
  });

  it('escada sobe até SIGKILL quando INT e TERM são ignorados', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'sh',
      args: ['-c', 'trap "" INT TERM; echo pronto; sleep 30'],
      cwd: tmp,
      env,
      rotulo: 'teste:teimoso',
      escada: ESCADA_CURTA,
    });
    const { saida } = coletar(p);
    await esperar(() => saida().includes('pronto'));
    const fim = await p.cancelar();
    expect(fim.escada?.sinais).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(fim.sinal).toBe('SIGKILL');
    expect(grupoVivo(p.pgid)).toBe(false);
  });

  it('sinal vai para o GRUPO: o neto morre junto', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'sh',
      args: ['-c', 'sleep 30 & echo $!; wait'],
      cwd: tmp,
      env,
      rotulo: 'teste:neto',
      escada: ESCADA_CURTA,
    });
    const { saida } = coletar(p);
    await esperar(() => saida().includes('\n'));
    const neto = Number(saida().trim());
    expect(pidVivo(neto)).toBe(true);
    expect(leitorProcLinux.stat(neto)?.pgid).toBe(p.pgid);
    await p.cancelar();
    await esperar(() => !pidVivo(neto));
  });

  it('líder sai sozinho com sobras no grupo → escada das sobras', async () => {
    const sup = new Supervisor({ graceFechamentoMs: 3000 });
    const p = await sup.iniciar({
      comando: 'sh',
      args: ['-c', 'sleep 30 & echo $!'],
      cwd: tmp,
      env,
      rotulo: 'teste:sobra',
    });
    const { saida } = coletar(p);
    const fim = await p.fim;
    const neto = Number(saida().trim());
    expect(fim.motivo).toBe('natural');
    expect(fim.escada?.sinais[0]).toBe('SIGTERM');
    await esperar(() => !pidVivo(neto));
  });

  it('timeout da etapa dispara a escada (motivo timeout)', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'sleep',
      args: ['30'],
      cwd: tmp,
      env,
      rotulo: 'teste:timeout',
      timeoutMs: 150,
      escada: ESCADA_CURTA,
    });
    coletar(p);
    const fim = await p.fim;
    expect(fim.motivo).toBe('timeout');
    expect(fim.escada?.sinais).toEqual(['SIGINT']);
  });

  it('silêncio só avisa (nunca mata) e a atividade rearma o aviso', async () => {
    const sup = new Supervisor();
    const avisos: number[] = [];
    const p = await sup.iniciar({
      comando: 'sleep',
      args: ['0.6'],
      cwd: tmp,
      env,
      rotulo: 'teste:silencio',
      avisoSilencioMs: 100,
      aoSilencio: (_p, ms) => avisos.push(ms),
    });
    coletar(p);
    await esperar(() => avisos.length === 1);
    p.registrarAtividade();
    await esperar(() => avisos.length === 2);
    const fim = await p.fim;
    expect(fim.motivo).toBe('natural');
    expect(fim.exit_code).toBe(0);
  });

  it('pausar manda SIGINT (sem escada) e o motivo é pausado', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({ comando: 'sleep', args: ['30'], cwd: tmp, env, rotulo: 'x' });
    coletar(p);
    p.pausar();
    const fim = await p.fim;
    expect(fim).toMatchObject({ motivo: 'pausado', sinal: 'SIGINT', escada: null });
  });

  it('varredura de cwd mata quem escapou do grupo dentro da worktree', async () => {
    const worktree = mkdtempSync(join(tmp, 'wt-'));
    const fugitivo = spawn('sleep', ['30'], { cwd: worktree, detached: true, stdio: 'ignore' });
    fugitivo.unref();
    await esperar(() => leitorProcLinux.cwd(fugitivo.pid!) === worktree);
    const sup = new Supervisor();
    const p = await sup.iniciar({
      comando: 'true',
      args: [],
      cwd: worktree,
      env,
      rotulo: 'teste:varredura',
      raizVarredura: worktree,
    });
    coletar(p);
    const fim = await p.fim;
    expect(fim.sobras_mortas).toContain(fugitivo.pid);
    await esperar(() => !pidVivo(fugitivo.pid!));
  });

  it('a varredura poupa as sessões protegidas (PTY do usuário)', async () => {
    const worktree = mkdtempSync(join(tmp, 'wt-'));
    const usuario = spawn('sleep', ['30'], { cwd: worktree, detached: true, stdio: 'ignore' });
    usuario.unref();
    await esperar(() => leitorProcLinux.cwd(usuario.pid!) === worktree);
    const sup = new Supervisor({ sessoesProtegidas: () => [usuario.pid!] });
    const p = await sup.iniciar({
      comando: 'true',
      args: [],
      cwd: worktree,
      env,
      rotulo: 'x',
      raizVarredura: worktree,
    });
    coletar(p);
    expect((await p.fim).sobras_mortas).toEqual([]);
    expect(pidVivo(usuario.pid!)).toBe(true);
    process.kill(-usuario.pid!, 'SIGKILL');
  });

  it('encerrarTodos aplica a escada em paralelo e recusa novos spawns', async () => {
    const sup = new Supervisor();
    const a = await sup.iniciar({ comando: 'sleep', args: ['30'], cwd: tmp, env, rotulo: 'a' });
    const b = await sup.iniciar({ comando: 'sleep', args: ['30'], cwd: tmp, env, rotulo: 'b' });
    coletar(a);
    coletar(b);
    const fins = await sup.encerrarTodos(ESCADA_CURTA);
    expect(fins.map((f) => f.motivo)).toEqual(['encerramento_app', 'encerramento_app']);
    await expect(
      sup.iniciar({ comando: 'true', args: [], cwd: tmp, env, rotulo: 'c' }),
    ).rejects.toMatchObject({ codigo: 'ENCERRANDO' });
  });

  it('matarOrfaos (boot): mata só o que a sonda reconhece como nosso', async () => {
    const orfao = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    orfao.unref();
    const estranho = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    estranho.unref();
    await esperar(() => leitorProcLinux.cmdline(estranho.pid!) !== null);
    const sup = new Supervisor();
    const resultado = await sup.matarOrfaos(
      [
        {
          pid: orfao.pid!,
          pgid: orfao.pid!,
          etapa_id: 'e1',
          inicio: '',
          rotulo: 'x',
          comando: 'sleep',
        },
        // pid "reutilizado": o processo vivo não é o comando registrado.
        {
          pid: estranho.pid!,
          pgid: estranho.pid!,
          etapa_id: 'e2',
          inicio: '',
          rotulo: 'y',
          comando: 'claude',
        },
        {
          pid: 2 ** 22 + 7,
          pgid: 2 ** 22 + 7,
          etapa_id: 'e3',
          inicio: '',
          rotulo: 'z',
          comando: 'claude',
        },
      ],
      ESCADA_CURTA,
    );
    expect(resultado.map((r) => r.estado)).toEqual(['vivo', 'pid_reutilizado', 'morto']);
    expect(resultado[0]?.escada?.encerrado).toBe(true);
    expect(resultado[1]?.escada).toBeNull();
    expect(pidVivo(estranho.pid!)).toBe(true);
    process.kill(-estranho.pid!, 'SIGKILL');
  });

  it('encerrarGrupo não sinaliza um grupo já vazio', async () => {
    const sinais: string[] = [];
    const r = await encerrarGrupo(12345, ESCADA_CURTA, {
      grupoVivo: () => false,
      sinalizarGrupo: (_g, s) => sinais.push(s),
    });
    expect(r).toMatchObject({ encerrado: true, sinais: [] });
    expect(sinais).toEqual([]);
  });

  it('o registro em memória espelha /proc (cmdline do filho)', async () => {
    const sup = new Supervisor();
    const p = await sup.iniciar({ comando: 'sleep', args: ['30'], cwd: tmp, env, rotulo: 'x' });
    coletar(p);
    const cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0');
    expect(cmd[0]).toBe('sleep');
    await p.cancelar(ESCADA_CURTA);
  });
});
