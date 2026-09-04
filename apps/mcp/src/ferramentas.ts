import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroApi, type ClienteChamados } from './cliente';

/**
 * Ferramentas MCP (specs/11 §7.2). Cada uma é um envelope fino sobre um endpoint
 * de `/api/v1`: nenhuma regra de negócio, nenhuma decisão de permissão — o que o
 * usuário configurado não pode fazer pela UI, também não pode por aqui.
 *
 * As DESCRIÇÕES são parte do contrato com o modelo: dizem o que a ferramenta faz,
 * o que cada enum significa e — no caso da mensagem pública — que o texto vai
 * PARA O CLIENTE FINAL. Um modelo que não sabe disso escreve jargão interno para
 * quem abriu o chamado.
 */

const STATUS = [
  'novo',
  'em_triagem',
  'aguardando_cliente',
  'em_atendimento',
  'resolvido',
  'fechado',
  'cancelado',
] as const;

const NATUREZAS = ['problema', 'alteracao', 'duvida'] as const;
const PRIORIDADES = ['baixa', 'media', 'alta', 'urgente'] as const;

/** Resultado textual padrão de uma ferramenta. */
type ResultadoFerramenta = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function texto(valor: unknown): ResultadoFerramenta {
  const t = typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2);
  return { content: [{ type: 'text', text: t }] };
}

/**
 * Converte a falha em resultado de ferramenta com o CÓDIGO estável do contrato —
 * erro corrigível pelo modelo (ex.: `transicao_invalida` leva a escolher outro
 * status), no mesmo espírito das ferramentas do worker (specs/05 §4.2).
 */
function erroFerramenta(e: unknown): ResultadoFerramenta {
  if (e instanceof ErroApi) {
    return { content: [{ type: 'text', text: `${e.codigo}: ${e.message}` }], isError: true };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `falha_inesperada: ${msg}` }], isError: true };
}

async function comErro(fn: () => Promise<ResultadoFerramenta>): Promise<ResultadoFerramenta> {
  try {
    return await fn();
  } catch (e) {
    return erroFerramenta(e);
  }
}

// ---------------------------------------------------------------------------
// Tradução de argumentos → query da API (pura, testável)
// ---------------------------------------------------------------------------

export interface ArgsListar {
  status?: string[];
  natureza?: string;
  prioridade?: string;
  atribuicao?: string;
  busca?: string;
  limite?: number;
  cursor?: string;
}

/** Monta a query de `GET /api/v1/chamados` (specs/11 §4.1). */
export function montarQueryListar(args: ArgsListar): Record<string, string | undefined> {
  return {
    // A API aceita lista separada por vírgula.
    status: args.status && args.status.length > 0 ? args.status.join(',') : undefined,
    natureza: args.natureza,
    prioridade: args.prioridade,
    atribuicao: args.atribuicao,
    busca: args.busca,
    limite: args.limite !== undefined ? String(args.limite) : undefined,
    cursor: args.cursor,
  };
}

export interface ArgsCriar {
  titulo: string;
  descricao: string;
  natureza?: string;
  prioridade?: string;
  sistema_alvo_id?: string;
  solicitante_email?: string;
}

/**
 * Monta o corpo de `POST /api/v1/chamados` (specs/11 §4.5): campos opcionais
 * ausentes/vazios NÃO viajam — a API trata "chave presente com string vazia"
 * como valor informado e recusaria o UUID vazio.
 */
export function montarCorpoCriar(args: ArgsCriar): Record<string, string> {
  const corpo: Record<string, string> = { titulo: args.titulo.trim(), descricao: args.descricao };
  const opcionais: Array<keyof ArgsCriar> = [
    'natureza',
    'prioridade',
    'sistema_alvo_id',
    'solicitante_email',
  ];
  for (const k of opcionais) {
    const v = args[k]?.trim();
    if (v) corpo[k] = v;
  }
  return corpo;
}

/** Caminho do chamado, com a referência (número ou UUID) escapada. */
export function caminhoChamado(ref: string, sufixo = ''): string {
  return `/api/v1/chamados/${encodeURIComponent(ref.trim())}${sufixo}`;
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function registrarFerramentas(
  server: McpServer,
  cliente: ClienteChamados,
  opts: { somenteLeitura: boolean },
): void {
  // ---- Leitura ------------------------------------------------------------

  server.registerTool(
    'chamados_listar',
    {
      title: 'Listar chamados',
      description:
        'Lista os chamados do helpdesk Chamados, com filtros. Retorna itens compactos ' +
        '(sem a descrição — use chamado_obter para o conteúdo). O escopo é o do usuário ' +
        'autenticado: operador/admin veem os chamados do tenant; cliente vê só os próprios. ' +
        'Use `cursor` (devolvido em `proximo_cursor`) para paginar.',
      inputSchema: {
        status: z
          .array(z.enum(STATUS))
          .optional()
          .describe(
            'Filtra por um ou mais status. novo=recém-criado; em_triagem=IA analisando; ' +
              'aguardando_cliente=falta resposta do cliente; em_atendimento=equipe tratando; ' +
              'resolvido=solução entregue; fechado/cancelado=terminais.',
          ),
        natureza: z.enum(NATUREZAS).optional().describe('problema | alteracao | duvida'),
        prioridade: z.enum(PRIORIDADES).optional().describe('baixa | media | alta | urgente'),
        atribuicao: z
          .string()
          .optional()
          .describe('"atribuido", "nao_atribuido" ou o UUID de um operador.'),
        busca: z
          .string()
          .optional()
          .describe('Texto (busca no título/descrição) ou número do chamado.'),
        limite: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Itens por página (default 20).'),
        cursor: z.string().optional().describe('Cursor de paginação da chamada anterior.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      comErro(async () =>
        texto(await cliente.requisitar('/api/v1/chamados', { query: montarQueryListar(args) })),
      ),
  );

  server.registerTool(
    'chamado_obter',
    {
      title: 'Obter chamado e timeline',
      description:
        'Retorna um chamado (com a descrição em texto) e a timeline completa de mensagens. ' +
        'Para operador/admin a timeline inclui as NOTAS INTERNAS (visibilidade "interna": ' +
        'diagnóstico da IA, SPECs, bastidores) além das mensagens públicas; para cliente, ' +
        'só as públicas. Aceita o número do chamado (ex.: "12") ou o UUID.',
      inputSchema: {
        ref: z.string().min(1).describe('Número do chamado (ex.: "12" ou "#12") ou o UUID.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ ref }) => comErro(async () => texto(await cliente.requisitar(caminhoChamado(ref)))),
  );

  server.registerTool(
    'sistemas_alvo_listar',
    {
      title: 'Listar sistemas-alvo',
      description:
        'Lista os sistemas-alvo ativos do tenant (id, nome, descrição) — os sistemas sobre ' +
        'os quais se abrem chamados. Use antes de chamado_criar quando ' +
        '`sistema_alvo_obrigatorio` vier true (tenant com mais de um sistema): aí o ' +
        'sistema_alvo_id é obrigatório na criação. Com um único sistema ele é preenchido ' +
        'automaticamente.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => comErro(async () => texto(await cliente.requisitar('/api/v1/sistemas-alvo'))),
  );

  if (opts.somenteLeitura) return;

  server.registerTool(
    'chamado_criar',
    {
      title: 'Abrir chamado',
      description:
        'Abre um chamado novo no helpdesk. O chamado entra como "novo" e a IA faz a triagem ' +
        'em seguida (classifica natureza/prioridade, pede informações ou resolve). ' +
        'PAPEL IMPORTA: se o usuário configurado é cliente, o chamado é aberto para ele mesmo; ' +
        'se é operador/admin, o chamado é aberto EM NOME DE um cliente e `solicitante_email` ' +
        '(e-mail de uma conta ativa com papel cliente) é OBRIGATÓRIO — em caso de dúvida, ' +
        'pergunte ao usuário quem é o solicitante em vez de chutar. Título curto (3–160 ' +
        'caracteres) e descrição em markdown com o problema/pedido como o cliente o relatou. ' +
        'Se a API responder "sistema_alvo_obrigatorio", chame sistemas_alvo_listar, escolha ' +
        '(ou pergunte) e repita com `sistema_alvo_id`. Retorna o id e o NÚMERO do chamado.',
      inputSchema: {
        titulo: z.string().min(3).max(160).describe('Título curto do chamado.'),
        descricao: z
          .string()
          .min(1)
          .describe('Descrição em markdown: o que acontece, onde, desde quando, como reproduzir.'),
        natureza: z
          .enum(NATUREZAS)
          .optional()
          .describe(
            'problema=algo quebrado; alteracao=pedido de mudança/nova funcionalidade; ' +
              'duvida=só quer entender algo. Omita se não souber: entra como "problema" e a IA ' +
              'reclassifica na triagem.',
          ),
        prioridade: z
          .enum(PRIORIDADES)
          .optional()
          .describe('baixa | media (default) | alta | urgente.'),
        sistema_alvo_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'UUID do sistema-alvo (de sistemas_alvo_listar). Só obrigatório se houver mais de um.',
          ),
        solicitante_email: z
          .string()
          .email()
          .optional()
          .describe(
            'E-mail do cliente solicitante. OBRIGATÓRIO quando o usuário configurado é ' +
              'operador/admin; NÃO informe quando é cliente (abre para si).',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      comErro(async () =>
        texto(
          await cliente.requisitar('/api/v1/chamados', {
            metodo: 'POST',
            corpo: montarCorpoCriar(args),
          }),
        ),
      ),
  );

  // ---- Escrita ------------------------------------------------------------

  server.registerTool(
    'chamado_publicar_mensagem',
    {
      title: 'Publicar mensagem no chamado',
      description:
        'Publica uma mensagem na timeline do chamado. ATENÇÃO à visibilidade: ' +
        '"publica" é ENVIADA AO CLIENTE FINAL (ele recebe notificação) — escreva na ' +
        'linguagem dele, sem jargão técnico, sem caminhos de arquivo nem nomes de tabela; ' +
        '"interna" é nota da equipe, invisível ao cliente, onde o detalhe técnico deve ficar. ' +
        'O corpo aceita markdown (listas, negrito, tabelas). Chamados fechados/cancelados ' +
        'não aceitam mensagens.',
      inputSchema: {
        ref: z.string().min(1).describe('Número do chamado (ex.: "12") ou o UUID.'),
        visibilidade: z
          .enum(['publica', 'interna'])
          .describe('"publica" = o cliente vê e é notificado; "interna" = só a equipe.'),
        corpo: z.string().min(1).describe('Texto da mensagem, em markdown.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, visibilidade, corpo }) =>
      comErro(async () =>
        texto(
          await cliente.requisitar(caminhoChamado(ref, '/mensagens'), {
            metodo: 'POST',
            corpo: { visibilidade, corpo },
          }),
        ),
      ),
  );

  server.registerTool(
    'chamado_alterar_status',
    {
      title: 'Alterar status do chamado',
      description:
        'Transiciona o status do chamado. A transição precisa ser válida a partir do status ' +
        'atual e permitida ao papel do usuário — uma recusa volta como "transicao_invalida". ' +
        'Fechado e cancelado são terminais (nada sai deles). Marcar como "resolvido" inicia o ' +
        'prazo de fechamento automático e o cliente é notificado.',
      inputSchema: {
        ref: z.string().min(1).describe('Número do chamado (ex.: "12") ou o UUID.'),
        status: z.enum(STATUS).describe('Status de destino.'),
        motivo: z
          .string()
          .optional()
          .describe('Motivo curto, registrado no histórico de auditoria do chamado.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, status, motivo }) =>
      comErro(async () =>
        texto(
          await cliente.requisitar(caminhoChamado(ref, '/status'), {
            metodo: 'POST',
            corpo: { status, ...(motivo ? { motivo } : {}) },
          }),
        ),
      ),
  );
}
