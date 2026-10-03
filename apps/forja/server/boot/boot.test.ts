import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChamadosFalso } from '../chamados/servidor-falso.test-apoio';
import { ErroSessaoOcupada as ErroSessaoOcupadaRunner } from '../claude/lock-sessoes';
import type { FuncaoExec, SaidaExec } from '../claude/compat';
import type { ConfigForja } from '../config';
import { abrirBanco } from '../db/data-source';
import { RunnerRoteirizado } from '../dominio/apoio-orquestrador.test-apoio';
import type { LeitorProc } from '../processos/proc-linux';
import { ErroSessaoOcupada, LocksSessaoMemoria } from '../processos/lock-sessao';
import { abrirSegredos } from '../segredos/keyring';
import { ARQUIVO_COMPAT, CompatCli, DiagnosticoForja, rodarSmokePerfis } from './compat-cli';
import { GerenteConexoes } from './conexoes';
import { iniciarForja } from './forja';
import { LockSessoesCompartilhado } from './locks';
import { descendentes, encerrarPids } from './processos';

/**
 * Boot e ligações da Forja (specs/forja/01 §4.1, §7, §3.2; 07 §2) sem `claude`
 * real e sem rede: exec falso para a CLI, Chamados falso por `fetch`, runner
 * roteirizado.
 */

const temporarios: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'forja-boot-'));
  temporarios.push(d);
  return d;
}
afterEach(() => {
  for (const d of temporarios.splice(0)) rmSync(d, { recursive: true, force: true });
});

function execFalso(respostas: Record<string, Partial<SaidaExec>>): FuncaoExec & {
  chamadas: string[];
} {
  const chamadas: string[] = [];
  const fn = (async (executavel: string, args: string[]) => {
    const chave = `${executavel} ${args.join(' ')}`;
    chamadas.push(chave);
    const r = respostas[chave];
    return { codigo: r?.codigo ?? 127, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  }) as FuncaoExec & { chamadas: string[] };
  fn.chamadas = chamadas;
  return fn;
}

const CLI_OK = {
  'claude --version': { codigo: 0, stdout: '2.1.288 (Claude Code)\n' },
  'claude auth status': {
    codigo: 0,
    stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
  },
  'git --version': { codigo: 0, stdout: 'git version 2.43.0\n' },
  'git config --global user.name': { codigo: 0, stdout: 'Fulano\n' },
  'git config --global user.email': { codigo: 0, stdout: 'fulano@exemplo.com\n' },
};

describe('CompatCli (01 §7, A9)', () => {
  it('versão fixada + login + git = pipeline liberado', async () => {
    const c = new CompatCli({ exec: execFalso(CLI_OK), dirDados: tmp() });
    await c.checar();
    expect(c.pipelineLiberado()).toBe(true);
    expect(c.smokeAprovado()).toBe(true);
  });

  it('versão nova bloqueia até aceitar com smoke aprovado (gravado por versão)', async () => {
    const dir = tmp();
    const respostas = { ...CLI_OK, 'claude --version': { codigo: 0, stdout: '2.2.0\n' } };
    const smokes: string[] = [];
    const c = new CompatCli({
      exec: execFalso(respostas),
      dirDados: dir,
      rodarSmoke: async (v) => {
        smokes.push(v);
        return { ok: true, falhas: [] };
      },
    });
    await c.checar();
    expect(c.pipelineLiberado()).toBe(false);
    await expect(c.aceitarVersao('2.1.999')).rejects.toMatchObject({ codigo: 'conflito' });
    await c.aceitarVersao('2.2.0');
    expect(smokes).toEqual(['2.2.0']);
    expect(c.pipelineLiberado()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(dir, ARQUIVO_COMPAT), 'utf8')).versoes['2.2.0'],
    ).toMatchObject({ smoke_aprovado: true });
    // Reboot: o aceite sobrevive.
    const depois = new CompatCli({ exec: execFalso(respostas), dirDados: dir });
    await depois.checar();
    expect(depois.pipelineLiberado()).toBe(true);
  });

  it('sem login bloqueia', async () => {
    const c = new CompatCli({
      exec: execFalso({ ...CLI_OK, 'claude auth status': { codigo: 1, stderr: 'not logged' } }),
      dirDados: tmp(),
    });
    await c.checar();
    expect(c.pipelineLiberado()).toBe(false);
  });
});

describe('DiagnosticoForja (06 §4.10)', () => {
  it('monta itens, faixa "sem sandbox" e pipeline_bloqueado', async () => {
    const dir = tmp();
    const exec = execFalso({ ...CLI_OK, 'claude --version': { codigo: 127, stderr: 'ENOENT' } });
    const compat = new CompatCli({ exec, dirDados: dir });
    const d = new DiagnosticoForja({
      compat,
      exec,
      dirDados: dir,
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      falhaPty: 'binário ausente',
      conexoes: () => [{ nome: 'acme', estado: 'erro', erro: 'senha inválida' }],
      host: '127.0.0.1',
      autoteste: async () => ({ ok: true, detalhe: 'ok' }),
    });
    const dto = await d.rodar();
    const cod = dto.itens.map((i) => i.codigo);
    expect(cod).toEqual(
      expect.arrayContaining([
        'cli_versao',
        'cli_login',
        'git_versao',
        'api_key_ambiente',
        'git_identidade',
        'gh',
        'chamados',
        'servidor_local',
        'modulos_nativos',
        'disco',
      ]),
    );
    expect(dto.pipeline_bloqueado).toBe(true);
    expect(dto.faixa).toMatch(/sem sandbox/);
    expect(dto.itens.find((i) => i.codigo === 'modulos_nativos')?.bloqueia).toBe('terminal');
    expect(JSON.stringify(dto)).not.toContain('sk-x');
  });
});

describe('rodarSmokePerfis (01 §7 "smoke de perfis")', () => {
  it('um spawn por perfil com haiku/max-turns 1/orçamento 0,05 e área apagada no fim', async () => {
    const dir = tmp();
    const comandos: string[][] = [];
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        capabilities: [],
        apiKeySource: 'none',
        permissionMode: 'PLACEHOLDER',
      }),
      JSON.stringify({ type: 'rate_limit_event' }),
      JSON.stringify({ type: 'result', structured_output: { ok: true } }),
    ];
    const r = await rodarSmokePerfis({
      dirDados: dir,
      versao: '2.2.0',
      envOrigem: { PATH: '/usr/bin', HOME: dir },
      executar: async (cmd) => {
        comandos.push(cmd.args);
        const modo = cmd.esperado.permissionMode;
        return {
          stdout: stdout.map((l) => l.replace('PLACEHOLDER', modo)).join('\n') + '\n',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    expect(comandos).toHaveLength(4);
    for (const args of comandos) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--max-turns', '1']));
      expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.05');
    }
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'compat'))).toBe(true);
    expect(existsSync(join(dir, 'compat', '2.2.0'))).toBe(false);
  });
});

describe('LockSessoesCompartilhado (01 §6.8: runner e PTY no mesmo lock)', () => {
  it('turno do runner bloqueia o Assumir e vice-versa', () => {
    const locks = new LocksSessaoMemoria();
    const runner = new LockSessoesCompartilhado(locks);
    runner.adquirir('s1', 'runner:e1:1');
    expect(() => locks.adquirir('s1', { tipo: 'terminal', sessao_terminal_id: 't1' })).toThrow(
      ErroSessaoOcupada,
    );
    runner.adquirir('s1', 'runner:e1:1'); // reentrante para o mesmo dono
    expect(() => runner.adquirir('s1', 'runner:e1:2')).toThrow(ErroSessaoOcupadaRunner);
    runner.liberar('s1', 'runner:e1:2'); // dono errado não solta
    expect(runner.dono('s1')).toBe('runner:e1:1');
    runner.liberar('s1', 'runner:e1:1');
    locks.adquirir('s1', { tipo: 'terminal', sessao_terminal_id: 't1' });
    expect(() => runner.adquirir('s1', 'runner:e2:3')).toThrow(/terminal:t1/);
    expect(runner.dono('s1')).toBe('terminal:t1');
  });
});

describe('processos do desligamento (01 §3.2)', () => {
  it('descendentes percorre a árvore por ppid', () => {
    const arvore: Record<number, number> = { 10: 1, 11: 10, 12: 11, 13: 10, 20: 1 };
    const leitor: LeitorProc = {
      pids: () => Object.keys(arvore).map(Number),
      stat: (pid) => ({ ppid: arvore[pid]!, pgid: pid, sid: pid }),
      cmdline: () => null,
      cwd: () => null,
    };
    expect(descendentes(10, leitor).sort()).toEqual([11, 12, 13]);
  });

  it('encerrarPids mata um processo real', async () => {
    const filho = spawn('sleep', ['30'], { stdio: 'ignore' });
    const saiu = new Promise((ok) => filho.on('exit', ok));
    expect(await encerrarPids([filho.pid!], 1000)).toBe(1);
    await saiu;
    expect(filho.killed || filho.exitCode !== null || filho.signalCode !== null).toBe(true);
  });
});

describe('GerenteConexoes (07 §2: sessão por conexão, senha só onde deve)', () => {
  it('testar com senha nao_guardada faz login; estado e fonte refletem a sessão', async () => {
    const dir = tmp();
    const banco = await abrirBanco({ dirDados: dir });
    try {
      const segredos = await abrirSegredos({ dirDados: dir, semKeyring: true });
      const chamados = new ChamadosFalso();
      const carregadas: string[] = [];
      const g = new GerenteConexoes({
        banco,
        segredos,
        fetch: chamados.fetch,
        aoCarregar: (id) => carregadas.push(id),
      });
      const c = await banco.transacao((r) =>
        r.conexoes.criar({
          nome: 'acme',
          url_base: 'https://suporte.acme.com',
          ambiente: 'dev',
          email: 'forja@acme.com',
          local_senha: 'nao_guardada',
        }),
      );
      expect(g.fonte(c.id)).toBeNull(); // dispara o carregamento
      await g.guardarSenha(c.id, chamados.senhaCorreta, 'nao_guardada');
      expect(await segredos.lerSenha(c.id)).toBeNull(); // nunca foi a disco
      const teste = await g.testar(c.id);
      expect(teste).toMatchObject({ ok: true, papel_aceito: true });
      expect(g.estado(c.id).estado).toBe('ok');
      expect(g.fonte(c.id)?.podeUsar()).toBe(true);
      expect(carregadas).toEqual([c.id]);
      const linha = await banco.ler((r) => r.conexoes.obter(c.id));
      expect(linha?.usuario_nome).toBe('Equipe de Suporte');
      expect(linha?.token_cifrado).toMatch(/^v1:/);
    } finally {
      await banco.fechar();
    }
  });

  it('senha errada → erro tipado credencial_invalida, sem lançar', async () => {
    const dir = tmp();
    const banco = await abrirBanco({ dirDados: dir });
    try {
      const segredos = await abrirSegredos({ dirDados: dir, semKeyring: true });
      const g = new GerenteConexoes({ banco, segredos, fetch: new ChamadosFalso().fetch });
      const c = await banco.transacao((r) =>
        r.conexoes.criar({
          nome: 'acme',
          url_base: 'https://suporte.acme.com',
          ambiente: 'dev',
          email: 'forja@acme.com',
          local_senha: 'keyring',
        }),
      );
      await g.guardarSenha(c.id, 'errada', 'keyring');
      // O backend caiu no arquivo 0600: a linha passa a dizer onde a senha está.
      expect((await banco.ler((r) => r.conexoes.obter(c.id)))?.local_senha).toBe('arquivo');
      const teste = await g.relogar(c.id);
      expect(teste.ok).toBe(false);
      expect(teste.erro?.codigo).toBe('credencial_invalida');
      expect(g.estado(c.id).estado).toBe('erro');
    } finally {
      await banco.fechar();
    }
  });
});

describe('iniciarForja (01 §4.1) sem claude real', () => {
  async function portaLivre(): Promise<number> {
    return new Promise((ok) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => ok(port));
      });
    });
  }

  it('sobe, serve a API com Diagnóstico e autoteste, desliga e o seq continua no reboot', async () => {
    const dir = tmp();
    const config: ConfigForja = {
      modo: 'producao',
      host: '127.0.0.1',
      porta: await portaLivre(),
      dirDados: dir,
      dirWebDist: '/nao/existe',
      versao: '1.2.3',
    };
    const token = 'token-do-teste-de-boot-com-tamanho-suficiente';
    const opcoes = {
      env: { PATH: process.env.PATH, HOME: dir },
      token,
      exec: execFalso(CLI_OK),
      runner: new RunnerRoteirizado(),
      terminal: false,
      polling: false,
      intervaloTickMs: 0,
      log: () => {},
    };
    const forja = await iniciarForja(config, opcoes);
    const h = { host: `127.0.0.1:${config.porta}`, cookie: `forja_sessao=${token}` };
    const diag = await forja.app.inject({ method: 'GET', url: '/api/diagnostico', headers: h });
    expect(diag.statusCode).toBe(200);
    const itens = diag.json().itens as { codigo: string; estado: string }[];
    expect(itens.find((i) => i.codigo === 'servidor_local')?.estado).toBe('ok');
    expect(itens.find((i) => i.codigo === 'modulos_nativos')?.estado).toBe('erro');
    expect(diag.json().pipeline_bloqueado).toBe(false);
    const shell = await forja.app.inject({ method: 'GET', url: '/api/shell', headers: h });
    expect(shell.statusCode).toBe(200);
    // 05 §4.9: a sentinela de integridade está LIGADA no boot real.
    expect(typeof forja.orq.n.deps.sentinela).toBe('function');
    // 05 §8.2: o token de boot é valor sensível conhecido (redigido e barrado no outbox).
    expect(forja.orq.n.segredos.has(token)).toBe(true);
    await forja.orq.n.publicar({
      execucao_id: null,
      etapa_id: null,
      tipo: 'cli.alerta',
      nivel: 'info',
      resumo: 'antes do reboot',
      dados: { codigo: 'x', bloqueante: false },
    });
    await forja.encerrar();
    await forja.encerrar(); // idempotente

    const denovo = await iniciarForja(config, { ...opcoes, runner: new RunnerRoteirizado() });
    try {
      const ev = await denovo.orq.n.publicar({
        execucao_id: null,
        etapa_id: null,
        tipo: 'cli.alerta',
        nivel: 'info',
        resumo: 'depois do reboot',
        dados: { codigo: 'y', bloqueante: false },
      });
      expect(ev.seq).toBeGreaterThan(1);
    } finally {
      await denovo.encerrar();
    }
  });
});
