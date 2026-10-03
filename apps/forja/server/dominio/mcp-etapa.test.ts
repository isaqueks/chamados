import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  montarAmbiente,
  planoExemplo,
  type AmbienteOrquestrador,
} from './apoio-orquestrador.test-apoio';

/**
 * MCP do Chamados somente leitura por etapa (FJ-030 §4; 07 §2.6): o
 * `mcp.<n>.json` leva o token da sessão da conexão em `CHAMADOS_TOKEN`, vale
 * só enquanto o processo do agente roda e some no fim da etapa.
 */

let amb: AmbienteOrquestrador | null = null;

afterEach(async () => {
  await amb?.limpar();
  amb = null;
});

describe('mcp.<n>.json da etapa (FJ-030 §4)', () => {
  it('existe durante o turno com o token da conexão e é apagado no fim da etapa', async () => {
    let lido: { caminho: string; conteudo: string } | null = null;
    amb = await montarAmbiente({
      orquestrador: {
        servidorMcp: { command: '/bin/true', args: ['mcp'] },
        mcpChamados: async () => ({
          url: 'https://suporte.acme.com',
          tenant: null,
          email: 'forja@acme.com',
          token: 'tok-sessao-123',
        }),
      },
    });
    amb.runner.roteiro('planejador', {
      antes: (c) => {
        const i = c.args.indexOf('--mcp-config');
        const caminho = i >= 0 ? c.args[i + 1]! : '';
        lido = { caminho, conteudo: existsSync(caminho) ? readFileSync(caminho, 'utf8') : '' };
      },
      saida: planoExemplo(),
    });
    await amb.orq.criarExecucao({ projeto_id: amb.projetoId, chamado_id: 'uuid-12' });
    await amb.orq.ocioso();

    expect(amb.runner.chamadasDe('planejador')).toHaveLength(1);
    const l = lido as { caminho: string; conteudo: string } | null;
    expect(l?.caminho).toMatch(/mcp\.\d+\.json$/);
    expect(amb.runner.chamadasDe('planejador')[0]!.args).toContain('--strict-mcp-config');
    const cfg = JSON.parse(l!.conteudo) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(['chamados']);
    expect(cfg.mcpServers.chamados!.env).toMatchObject({
      CHAMADOS_TOKEN: 'tok-sessao-123',
      CHAMADOS_EMAIL: 'forja@acme.com',
      CHAMADOS_MCP_SOMENTE_LEITURA: 'true',
    });
    expect(cfg.mcpServers.chamados!.env.CHAMADOS_SENHA).toBeUndefined();
    // Fim da etapa: o arquivo com o token não fica no disco.
    expect(existsSync(l!.caminho)).toBe(false);
  });
});
