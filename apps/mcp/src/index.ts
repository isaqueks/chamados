import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClienteChamados } from '@chamados/cliente-api';
import { carregarConfig, configCliente, ErroConfig } from './config';
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
  for (const aviso of cfg.avisos) log(`aviso: ${aviso}`);
  const cliente = new ClienteChamados(configCliente(cfg));

  const server = new McpServer(
    { name: 'chamados', version: '0.3.0' },
    {
      instructions:
        'Helpdesk Chamados: leitura e atendimento de chamados de suporte. Use chamados_listar ' +
        'para achar chamados e chamado_obter para ler a conversa completa antes de agir. ' +
        'Mensagens com visibilidade "publica" vão para o cliente final; detalhe técnico ' +
        'pertence a notas "interna". chamado_criar abre um chamado novo: com usuário ' +
        'operador/admin exige o e-mail do cliente solicitante (pergunte se não souber). ' +
        'Anexos e imagens do chamado estão listados em chamado_obter; use anexo_obter ' +
        'para ver a imagem ou ler o arquivo.',
    },
  );

  registrarFerramentas(server, cliente, { somenteLeitura: cfg.somenteLeitura });

  await server.connect(new StdioServerTransport());
  log(
    `pronto — ${cfg.baseUrl} como ${cfg.email}` +
      (cfg.tenantSlug ? ` (tenant ${cfg.tenantSlug})` : '') +
      // Só o MODO de credencial — o token em si nunca vai para log (specs/11 §7.1).
      (cfg.token ? (cfg.senha ? ' [token de sessão + senha]' : ' [token de sessão]') : '') +
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
