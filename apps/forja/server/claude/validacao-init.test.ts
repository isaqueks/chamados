import { describe, expect, it } from 'vitest';
import { lerFixture } from './fixtures/processo-falso';
import type { ExpectativaInit } from './perfis';
import type { InitCli } from './stream';
import { validarInit } from './validacao-init';

const esperadoT1: ExpectativaInit = {
  perfil: 'condutor_t1',
  permissionMode: 'bypassPermissions',
  ferramentas: ['Agent', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  comSchema: true,
  modelo: 'claude-fable-5-1',
  agentesAceitos: [
    'implementador',
    'claude',
    'Explore',
    'general-purpose',
    'Plan',
    'statusline-setup',
  ],
  apiKeySource: 'none',
  modelosPermitidos: ['claude-fable-5-1', 'claude-opus-5-5'],
  mcpChamados: false,
};

const initT1: InitCli = {
  type: 'system',
  subtype: 'init',
  session_id: 's',
  claude_code_version: '2.1.288',
  permissionMode: 'bypassPermissions',
  tools: ['Task', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'StructuredOutput'],
  mcp_servers: [],
  apiKeySource: 'none',
  agents: ['claude', 'implementador', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
  model: 'claude-fable-5-1',
  plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin' }],
  capabilities: ['interrupt_receipt_v1'],
};

describe('validarInit (01 §6.4)', () => {
  it('init coerente passa (Task ≡ Agent, StructuredOutput com schema, plugin embutido ignorado)', () => {
    const r = validarInit(initT1, esperadoT1, '2.1.288');
    expect(r.ok).toBe(true);
    expect(r.divergencias).toEqual([]);
    expect(r.alertas).toEqual([]);
    expect(r.capabilities).toEqual(['interrupt_receipt_v1']);
    expect(r.recorte.permissionMode).toBe('bypassPermissions');
  });

  it.each([
    ['versão', { claude_code_version: '2.1.300' }],
    ['modo', { permissionMode: 'default' }],
    ['ferramenta a mais', { tools: [...initT1.tools!, 'WebFetch'] }],
    ['ferramenta a menos', { tools: ['Task', 'Read', 'StructuredOutput'] }],
    ['MCP', { mcp_servers: [{ name: 'github', status: 'connected' }] }],
    ['credencial', { apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['modelo', { model: 'claude-opus-5-5' }],
  ])('diverge por %s', (_nome, mudanca) => {
    const r = validarInit({ ...initT1, ...mudanca } as InitCli, esperadoT1, '2.1.288');
    expect(r.ok).toBe(false);
    expect(r.divergencias.length).toBeGreaterThan(0);
  });

  it('MCP do Chamados esperado (FJ-030 §4): conectado passa; outro servidor ainda diverge', () => {
    const comMcp = { ...esperadoT1, mcpChamados: true };
    const tools = [...initT1.tools!, 'mcp__chamados__chamado_obter', 'mcp__chamados__anexo_obter'];
    const ok = validarInit(
      { ...initT1, tools, mcp_servers: [{ name: 'chamados', status: 'connected' }] },
      comMcp,
      '2.1.288',
    );
    expect(ok.ok).toBe(true);
    expect(ok.alertas).toEqual([]);
    const outro = validarInit(
      {
        ...initT1,
        tools,
        mcp_servers: [
          { name: 'chamados', status: 'connected' },
          { name: 'github', status: 'connected' },
        ],
      },
      comMcp,
      '2.1.288',
    );
    expect(outro.divergencias.join(' ')).toMatch(/github/);
    // Sem esperar o MCP, uma ferramenta mcp__chamados__* é ferramenta a mais.
    expect(validarInit({ ...initT1, tools }, esperadoT1, '2.1.288').ok).toBe(false);
  });

  it('MCP do Chamados com falha ou ausente só avisa (os agentes seguem sem ele)', () => {
    const comMcp = { ...esperadoT1, mcpChamados: true };
    const falhou = validarInit(
      { ...initT1, mcp_servers: [{ name: 'chamados', status: 'failed' }] },
      comMcp,
      '2.1.288',
    );
    expect(falhou.ok).toBe(true);
    expect(falhou.alertas[0]).toMatch(/MCP do Chamados failed/);
    const ausente = validarInit(initT1, comMcp, '2.1.288');
    expect(ausente.ok).toBe(true);
    expect(ausente.alertas[0]).toMatch(/ausente/);
  });

  it('versão divergente bloqueia o pipeline', () => {
    expect(
      validarInit({ ...initT1, claude_code_version: '2.2.0' }, esperadoT1, '2.1.288')
        .versaoDivergente,
    ).toBe(true);
  });

  it('agente fora do papel no T1 é reportado para atualizar a lista e reiniciar', () => {
    const r = validarInit(
      { ...initT1, agents: [...initT1.agents!, 'plugin:auditor'] },
      esperadoT1,
      '2.1.288',
    );
    expect(r.ok).toBe(false);
    expect(r.divergencias).toEqual([]);
    expect(r.agentesForaDoPapel).toEqual(['plugin:auditor']);
  });

  it('plugin de usuário carregado no T1 gera só alerta', () => {
    const r = validarInit(
      { ...initT1, plugins: [{ name: 'frontend-design', path: '/home/u/.claude/plugins/x' }] },
      esperadoT1,
      '2.1.288',
    );
    expect(r.ok).toBe(true);
    expect(r.alertas[0]).toContain('frontend-design');
  });

  it('modelo com sufixo de data é o mesmo modelo; API key escolhida aceita fonte ≠ none', () => {
    const r = validarInit(
      { ...initT1, model: 'claude-fable-5-1-20261001', apiKeySource: 'ANTHROPIC_API_KEY' },
      { ...esperadoT1, apiKeySource: 'api_key' },
      '2.1.288',
    );
    expect(r.ok).toBe(true);
  });

  it('o init real da fixture a (modo default, sem ferramentas) diverge do planejador', () => {
    const init = JSON.parse(lerFixture('a.jsonl').split('\n')[0]!) as InitCli;
    const r = validarInit(
      init,
      {
        ...esperadoT1,
        perfil: 'planejador',
        permissionMode: 'dontAsk',
        ferramentas: ['Read', 'Grep', 'Glob'],
        agentesAceitos: null,
      },
      '2.1.288',
    );
    expect(r.ok).toBe(false);
    expect(r.versaoDivergente).toBe(false);
    expect(r.divergencias.some((d) => d.includes('permissionMode default'))).toBe(true);
    expect(r.divergencias.some((d) => d.includes('ferramentas'))).toBe(true);
    expect(r.alertas).toEqual([]);
  });
});
