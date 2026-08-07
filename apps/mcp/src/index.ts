import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { carregarConfig, ErroConfig } from './config';
import { ClienteChamados } from './cliente';
import { registrarFerramentas } from './ferramentas';

/**
 * Servidor MCP do Chamados (specs/11 §7) — transporte **stdio**, para Claude Code
 * e Claude Desktop.
 *
 * REGRA DE OURO DO STDIO: o protocolo MCP É o stdout. Nada além das mensagens do
 * servidor pode ser escrito lá — todo log vai para stderr (`console.error`), ou o
 * cliente quebra ao tentar parsear a linha extra como JSON-RPC.
 */

function log(msg: string): void {
  console.error(`[chamados-mcp] ${msg}`);
}

async function main(): Promise<void> {
  const cfg = carregarConfig();
  const cliente = new ClienteChamados(cfg);

  const server = new McpServer(
    { name: 'chamados', version: '0.1.0' },
    {
      instructions:
        'Helpdesk Chamados: leitura e atendimento de chamados de suporte. Use chamados_listar ' +
        'para achar chamados e chamado_obter para ler a conversa completa antes de agir. ' +
        'Mensagens com visibilidade "publica" vão para o cliente final; detalhe técnico ' +
        'pertence a notas "interna".',
    },
  );

  registrarFerramentas(server, cliente, { somenteLeitura: cfg.somenteLeitura });

  await server.connect(new StdioServerTransport());
  log(
    `pronto — ${cfg.baseUrl} como ${cfg.email}` +
      (cfg.tenantSlug ? ` (tenant ${cfg.tenantSlug})` : '') +
      (cfg.somenteLeitura ? ' [somente leitura]' : ''),
  );
}

main().catch((e: unknown) => {
  // Erro de configuração é do OPERADOR (falta env): mensagem acionável, sem stack.
  if (e instanceof ErroConfig) {
    log(`configuração inválida: ${e.message}`);
    process.exit(2);
  }
  log(`falha ao iniciar: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
