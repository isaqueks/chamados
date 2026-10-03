import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArquivoAgentes,
  caminhoRegra,
  gerarAgentesT1,
  gerarAgentesT2,
  gerarConfigMcp,
  gerarSettings,
  gravarArquivosEtapa,
  NEGACOES_GIT_LEITURA_T2,
  type EntradaSettings,
} from './settings-gerados';

const base: EntradaSettings = {
  perfil: 'condutor_t1',
  dirDados: '/home/u/.local/share/forja',
  execucaoId: 'e1',
  outrasExecucoes: ['e0', 'e1', 'e2'],
  worktreePropria: '/home/u/.local/share/forja/worktrees/acme/12-e1e1e1e1',
  worktreesExistentes: [
    '/home/u/.local/share/forja/worktrees/acme/12-e1e1e1e1/',
    '/home/u/.local/share/forja/worktrees/acme/13-e2e2e2e2',
    '/home/u/.local/share/forja/worktrees/acme/_integracao/abcd1234',
  ],
  repoDirUsuario: '/home/u/dev/acme',
  reposOutrosProjetos: ['/home/u/dev/outro'],
  branchDestino: 'main',
};

describe('gerarSettings (01 §6.3, 05 §4.4)', () => {
  it('desliga hooks e nega o git do app', () => {
    const s = gerarSettings(base);
    expect(s.disableAllHooks).toBe(true);
    for (const regra of [
      'Bash(git push*)',
      'Bash(git remote*)',
      'Bash(git reset --hard*)',
      'Bash(git checkout main*)',
      'Bash(git merge*)',
      'Bash(git worktree*)',
      'Bash(git commit*)',
    ]) {
      expect(s.permissions.deny).toContain(regra);
    }
  });

  it('nega segredos do usuário e caminhos enumerados do diretório de dados com // absoluto', () => {
    const d = gerarSettings(base).permissions.deny;
    expect(d).toContain('Read(~/.ssh/**)');
    expect(d).toContain('Read(~/.config/gh/**)');
    expect(d).toContain('Read(~/.claude/.credentials.json)');
    const dados = '//home/u/.local/share/forja';
    for (const c of [
      'forja.db*',
      'backups/**',
      'credenciais.json',
      'configuracoes.json',
      'projetos/**',
    ]) {
      expect(d).toContain(`Read(${dados}/${c})`);
      expect(d).toContain(`Edit(${dados}/${c})`);
    }
    // T1 (B7, FJ-030 §3): a própria execução negada por enumeração, menos `evidencias/`.
    expect(d).not.toContain(`Edit(${dados}/execucoes/**)`);
    for (const c of ['entrada/**', 'etapas/**', 'logs/**', 'mcp.*', 'settings.*']) {
      expect(d).toContain(`Read(${dados}/execucoes/e1/${c})`);
    }
    expect(d.some((r) => r.includes('/execucoes/e1/evidencias'))).toBe(false);
    expect(d).toContain(`Edit(${dados}/execucoes/e2/**)`);
    // T2/T3 continuam sem nada de `execucoes/`.
    expect(gerarSettings({ ...base, perfil: 'condutor_t2' }).permissions.deny).toContain(
      `Edit(${dados}/execucoes/**)`,
    );
    // nunca o diretório de dados inteiro: a própria worktree mora lá
    expect(d).not.toContain(`Read(${dados}/**)`);
    expect(d).toContain(`Read(${dados}/worktrees/acme/13-e2e2e2e2/**)`);
    expect(d).toContain(`Edit(${dados}/worktrees/acme/_integracao/abcd1234/**)`);
    expect(d.some((r) => r.includes('12-e1e1e1e1'))).toBe(false);
    expect(d).toContain('Read(./.env*)');
    expect(d).toContain('Edit(./.env*)');
    expect(d).toContain('Read(//home/u/dev/outro/**)');
    // regra de caminho com Write é aceita pela CLI mas nunca consultada
    expect(d.some((r) => r.startsWith('Write('))).toBe(false);
  });

  it('T1 nega edição da persistência do usuário e do checkout dele', () => {
    const d = gerarSettings(base).permissions.deny;
    for (const r of [
      'Edit(~/.bashrc)',
      'Edit(~/.zshrc)',
      'Edit(~/.gitconfig)',
      'Edit(~/.claude/**)',
      'Edit(~/.config/**)',
    ]) {
      expect(d).toContain(r);
    }
    expect(d).toContain('Edit(//home/u/dev/acme/.git/hooks/**)');
    expect(d).toContain('Edit(//home/u/dev/acme/**)');
    expect(gerarSettings({ ...base, perfil: 'condutor_t2' }).permissions.deny).not.toContain(
      'Edit(~/.bashrc)',
    );
  });

  it('planejador lê a própria entrada: nega o resto da execução e as outras execuções', () => {
    const d = gerarSettings({ ...base, perfil: 'planejador' }).permissions.deny;
    const exec = '//home/u/.local/share/forja/execucoes';
    expect(d).not.toContain(`Read(${exec}/**)`);
    expect(d.some((r) => r.includes('/execucoes/e1/entrada'))).toBe(false);
    expect(d).toContain(`Read(${exec}/e1/etapas/**)`);
    expect(d).toContain(`Read(${exec}/e1/settings.*)`);
    expect(d).toContain(`Read(${exec}/e0/**)`);
    expect(d).toContain(`Read(${exec}/e2/**)`);
    expect(d).not.toContain(`Read(${exec}/e1/**)`);
  });

  it('nega _integracao/** de todo projeto por regra fixa (fila de merge, base-<exec8>)', () => {
    const d = gerarSettings({ ...base, worktreesExistentes: [] }).permissions.deny;
    const regra = '//home/u/.local/share/forja/worktrees/*/_integracao/**';
    expect(d).toContain(`Read(${regra})`);
    expect(d).toContain(`Edit(${regra})`);
  });

  it('enumera do DISCO as worktrees e execuções retidas (não só as ativas)', async () => {
    const dados = await mkdtemp(join(tmpdir(), 'forja-settings-'));
    try {
      for (const d of [
        'worktrees/acme/12-e1e1e1e1',
        'worktrees/acme/9-e9e9e9e9',
        'worktrees/acme/_integracao/base-e9e9e9e9',
        'worktrees/beta/3-b3b3b3b3',
        'execucoes/e1/entrada',
        'execucoes/e9/entrada',
      ]) {
        await mkdir(join(dados, d), { recursive: true });
      }
      const entrada: EntradaSettings = {
        ...base,
        perfil: 'planejador',
        dirDados: dados,
        outrasExecucoes: [],
        worktreePropria: join(dados, 'worktrees/acme/12-e1e1e1e1'),
        worktreesExistentes: [],
      };
      const d = gerarSettings(entrada).permissions.deny;
      const r = `/${dados}`;
      expect(d).toContain(`Read(${r}/worktrees/acme/9-e9e9e9e9/**)`);
      expect(d).toContain(`Edit(${r}/worktrees/beta/3-b3b3b3b3/**)`);
      expect(d).toContain(`Read(${r}/execucoes/e9/**)`);
      expect(d).not.toContain(`Read(${r}/execucoes/e1/**)`);
      expect(d.some((x) => x.includes('12-e1e1e1e1'))).toBe(false);
      // _integracao fica na regra fixa, não enumerado como worktree
      expect(d.some((x) => x.includes('/acme/_integracao/**'))).toBe(false);
    } finally {
      await rm(dados, { recursive: true, force: true });
    }
  });

  it('T2: o allow de git só leitura não aceita --output, --no-index nem caminho fora da worktree', () => {
    const t2 = gerarSettings({ ...base, perfil: 'condutor_t2' }).permissions.deny;
    for (const r of NEGACOES_GIT_LEITURA_T2) expect(t2).toContain(r);
    expect(t2).toContain('Bash(git *--output*)');
    expect(t2).toContain('Bash(git *--no-index*)');
    expect(gerarSettings(base).permissions.deny).not.toContain('Bash(git *--output*)');
  });

  it('caminho relativo é recusado', () => {
    expect(() => caminhoRegra('dados/x')).toThrow();
    expect(caminhoRegra('/a/b/')).toBe('//a/b');
  });
});

describe('agentes.json (04 §3)', () => {
  it('T1: só o implementador, Opus com ID completo, sem Agent, omitClaudeMd', () => {
    const a = gerarAgentesT1({
      modelo: 'claude-opus-5-5',
      esforco: 'high',
      promptImplementador: 'B1…',
    });
    expect(Object.keys(a)).toEqual(['implementador']);
    expect(a.implementador).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      maxTurns: 80,
      omitClaudeMd: true,
    });
    expect(a.implementador?.permissionMode).toBeUndefined();
  });

  it('T2: dois revisores em dontAsk com maxTurns 40', () => {
    const a = gerarAgentesT2({
      modelo: 'claude-opus-5-5',
      esforco: 'high',
      promptRevisorCorrecao: 'c',
      promptRevisorSeguranca: 's',
    });
    expect(Object.keys(a).sort()).toEqual(['revisor_correcao', 'revisor_seguranca']);
    expect(a.revisor_seguranca).toMatchObject({
      permissionMode: 'dontAsk',
      maxTurns: 40,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    });
  });

  it('zod estrito: campo desconhecido, campo proibido, alias de modelo e Agent nas tools são recusados', () => {
    const ok = {
      description: 'd',
      prompt: 'p',
      model: 'claude-opus-5-5',
      effort: 'high',
      tools: ['Read'],
      maxTurns: 1,
      omitClaudeMd: true,
    };
    expect(ArquivoAgentes.safeParse({ x: ok }).success).toBe(true);
    expect(ArquivoAgentes.safeParse({ x: { ...ok, maxturns: 3 } }).success).toBe(false);
    expect(ArquivoAgentes.safeParse({ x: { ...ok, hooks: {} } }).success).toBe(false);
    expect(ArquivoAgentes.safeParse({ x: { ...ok, mcpServers: {} } }).success).toBe(false);
    expect(ArquivoAgentes.safeParse({ x: { ...ok, model: 'opus' } }).success).toBe(false);
    expect(ArquivoAgentes.safeParse({ x: { ...ok, tools: ['Read', 'Agent'] } }).success).toBe(
      false,
    );
  });
});

describe('gravarArquivosEtapa', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('mcp.<n>.json (FJ-030 §4): só o servidor chamados, somente leitura, token por env, 0600', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forja-mcp-'));
    const mcp = gerarConfigMcp(
      { command: '/repo/node_modules/.bin/tsx', args: ['/repo/apps/mcp/src/index.ts'] },
      { url: 'https://suporte.acme.com', tenant: null, email: 'forja@acme.com', token: 'tok-123' },
      { PATH: '/usr/bin', HOME: '/home/u', GH_TOKEN: 'nunca' },
    );
    expect(Object.keys(mcp.mcpServers)).toEqual(['chamados']);
    expect(mcp.mcpServers.chamados?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      CHAMADOS_URL: 'https://suporte.acme.com',
      CHAMADOS_EMAIL: 'forja@acme.com',
      CHAMADOS_TOKEN: 'tok-123',
      CHAMADOS_MCP_SOMENTE_LEITURA: 'true',
    });
    const r = await gravarArquivosEtapa(dir, 2, {
      settings: gerarSettings(base),
      sistema: '# B1',
      mcp,
    });
    expect(r.mcp).toBe(join(dir, 'mcp.2.json'));
    expect((await stat(r.mcp!)).mode & 0o777).toBe(0o600);
    expect(r.sha256.mcp).toMatch(/^[0-9a-f]{64}$/);
    const sem = await gravarArquivosEtapa(dir, 3, { settings: gerarSettings(base), sistema: '#' });
    expect(sem.mcp).toBeNull();
  });

  it('grava settings/agentes/sistema numerados, 0600, com sha256', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forja-claude-'));
    const exec = join(dir, 'execucoes', 'e1');
    const r = await gravarArquivosEtapa(exec, 3, {
      settings: gerarSettings(base),
      agentes: gerarAgentesT1({
        modelo: 'claude-opus-5-5',
        esforco: 'high',
        promptImplementador: 'p',
      }),
      sistema: '# Papel\n',
    });
    expect(r.settings).toBe(join(exec, 'settings.3.json'));
    expect(r.agentes).toBe(join(exec, 'agentes.3.json'));
    expect(r.sistema).toBe(join(exec, 'sistema.3.md'));
    expect(JSON.parse(await readFile(r.settings, 'utf8')).disableAllHooks).toBe(true);
    expect((await stat(r.settings)).mode & 0o777).toBe(0o600);
    expect(r.sha256.settings).toMatch(/^[0-9a-f]{64}$/);

    const semAgentes = await gravarArquivosEtapa(exec, 4, {
      settings: gerarSettings(base),
      sistema: 'x',
    });
    expect(semAgentes.agentes).toBeNull();
    expect(semAgentes.sha256.agentes).toBeNull();
  });
});
