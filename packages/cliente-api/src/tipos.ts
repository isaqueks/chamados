import type {
  Complexidade,
  Natureza,
  Papel,
  Prioridade,
  StatusChamado,
  VisibilidadeMensagem,
} from '@chamados/shared';

/**
 * Tipos do contrato REAL da API `/api/v1` (specs/11 §4; specs/forja/07 §2–§3 e
 * §11), espelhando as projeções de `apps/web/src/lib/api-chamados.ts` no commit
 * `9710bd5` — inclusive as divergências D3 que a spec 11 ainda não documenta
 * (`categoria_nome`, `resolvido_em`, `fechar_automaticamente_em`, `fechado_em`,
 * `reaberto_count`).
 *
 * Campos OPCIONAIS (`?`) são os que a API só emite para a EQUIPE (operador/admin)
 * — o serializer os remove do `cliente` — ou que só existem depois do deploy da
 * D-036 (L1/L2). Ausência é informação: a Forja detecta a D-036 pela presença de
 * `ia_silenciada` no item da lista (07 §2.5).
 *
 * Só tipos (`import type`): o pacote não carrega `@chamados/shared` em runtime.
 */

/** Formato do corpo (descrição e mensagens) no detalhe — D-035. `texto` é o default. */
export type FormatoCorpo = 'texto' | 'markdown' | 'html';

// ---------------------------------------------------------------------------
// Sessão (specs/11 §2)
// ---------------------------------------------------------------------------

/** `POST /api/v1/sessao` → 200. */
export interface RespostaSessao {
  token: string;
  /** Expiração por INATIVIDADE (8 h deslizantes); informativa — quem manda é o 401. */
  expira_em: string;
  usuario: { id: string; nome: string; email: string; papel: Papel };
  tenant: { slug: string; nome_exibicao: string };
}

/** Identidade da sessão corrente, projetada do login. */
export interface Identidade {
  /** `usuario.id` — a Forja precisa dele para a atribuição (L4). */
  id: string;
  nome: string;
  email: string;
  papel: Papel;
  /** `tenant.nome_exibicao` (compatível com o `quemSou()` histórico do MCP). */
  tenant: string;
  tenantSlug: string;
  /** `expira_em` do login (ISO 8601). */
  expiraEm: string;
}

// ---------------------------------------------------------------------------
// Chamados (specs/11 §4.1, §4.2)
// ---------------------------------------------------------------------------

/** `atribuicao` da listagem: palavras-chave ou o UUID de um operador. */
export type FiltroAtribuicao = 'atribuido' | 'nao_atribuido' | (string & {});

/**
 * Filtros de `GET /api/v1/chamados`. Valor fora do domínio → `400
 * parametro_invalido`. ATENÇÃO (D4): parâmetro DESCONHECIDO é ignorado em
 * silêncio — `complexidade` só filtra depois da D-036 (L3); antes, filtre em
 * memória (07 §3, §11.6).
 */
export interface FiltrosListarChamados {
  /** Um ou vários (viaja como CSV). */
  status?: StatusChamado | StatusChamado[];
  /** Um só: a API não aceita lista (07 §3 — a fila faz 2 chamadas). */
  natureza?: Natureza;
  prioridade?: Prioridade;
  atribuicao?: FiltroAtribuicao;
  sistema_alvo_id?: string;
  categoria_id?: string;
  busca?: string;
  /** 1–100. */
  limite?: number;
  cursor?: string;
  /** D-036 L3 (CSV). Recusado para `cliente` (403). Ignorado antes do deploy (D4). */
  complexidade?: Complexidade | Complexidade[];
}

/** Item compacto da listagem (`projetarItemLista`). */
export interface ItemChamado {
  id: string;
  numero: number;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  /** Só equipe. `null` = ainda não avaliada. */
  complexidade?: Complexidade | null;
  /** Só equipe. `null` = não atribuído. */
  operador_nome?: string | null;
  solicitante_nome: string | null;
  sistema_nome: string | null;
  categoria_nome: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** D-036 L1 no item da lista (só equipe); no detalhe já existe hoje. */
  ia_silenciada?: boolean;
  /** D-036 L2 (só equipe). */
  sistema_alvo_id?: string | null;
  /** D-036 L2 (só equipe). */
  categoria_id?: string | null;
  /** D-036 L2 (só equipe). */
  operador_id?: string | null;
}

/** `GET /api/v1/chamados` → 200. `proximo_cursor = null` encerra a paginação. */
export interface PaginaChamados {
  itens: ItemChamado[];
  proximo_cursor: string | null;
}

/** Metadados de anexo (`projetarAnexo`); `url` é a rota Bearer `/api/v1/anexos/<id>`. */
export interface AnexoApi {
  id: string;
  nome_arquivo: string;
  content_type: string;
  tamanho_bytes: number;
  inline: boolean;
  url: string;
}

/** Chamado no detalhe (`projetarDetalhe`): o item + descrição, anexos e datas do ciclo. */
export interface DetalheChamado extends ItemChamado {
  /** Descrição no `formato` pedido. */
  descricao: string;
  formato: FormatoCorpo;
  /** Anexos da descrição (imagens inline incluídas). */
  anexos: AnexoApi[];
  /** Só equipe (já presente antes da D-036). */
  ia_silenciada?: boolean;
  resolvido_em: string | null;
  /** Prazo do auto-fechamento de um `resolvido` (07 §6). */
  fechar_automaticamente_em: string | null;
  fechado_em: string | null;
  reaberto_count: number;
}

/** Mensagem da timeline (`projetarMensagens`), em ordem ASC. */
export interface MensagemChamado {
  id: string;
  autor_nome: string | null;
  autor_papel: Papel | null;
  /** Só equipe (o cliente nem recebe notas internas). */
  visibilidade?: VisibilidadeMensagem;
  corpo: string;
  anexos: AnexoApi[];
  created_at: string | null;
}

/** `GET /api/v1/chamados/{ref}` → 200. */
export interface RespostaDetalheChamado {
  chamado: DetalheChamado;
  mensagens: MensagemChamado[];
}

// ---------------------------------------------------------------------------
// Escritas (specs/11 §4.3–§4.5; D-036 L1/L4 em specs/forja/07 §11)
// ---------------------------------------------------------------------------

/** `POST …/mensagens`. `corpo` em MARKDOWN (≤ 50.000 caracteres). */
export interface EntradaMensagem {
  visibilidade: VisibilidadeMensagem;
  corpo: string;
}

/** `POST …/status`. `motivo` vai ao payload do `EventoChamado`. */
export interface EntradaStatus {
  status: StatusChamado;
  motivo?: string;
}

/**
 * `POST /api/v1/chamados`. `sistema_alvo_id` XOR `categoria_id`;
 * `solicitante_email` XOR `solicitante_id` (obrigatório para equipe, proibido
 * para `cliente`). Campos `undefined` não viajam.
 */
export interface EntradaCriarChamado {
  titulo: string;
  /** Markdown. */
  descricao: string;
  natureza?: Natureza;
  prioridade?: Prioridade;
  sistema_alvo_id?: string;
  categoria_id?: string;
  solicitante_email?: string;
  solicitante_id?: string;
}

/** `POST /api/v1/chamados` → 201. */
export interface RespostaCriarChamado {
  id: string;
  numero: number;
}

/** `POST …/mensagens` → 201. */
export interface RespostaMensagem {
  id: string;
}

/** `POST …/status` → 200. */
export interface RespostaStatus {
  status: StatusChamado;
}

/** D-036 L1 — `POST …/ia` → 200 (idempotente). */
export interface RespostaSilencioIa {
  ia_silenciada: boolean;
}

/** D-036 L4 — `POST …/atribuicao` → 200. */
export interface RespostaAtribuicao {
  operador_id: string | null;
}

// ---------------------------------------------------------------------------
// Sistemas-alvo e anexos (specs/11 §4.6, §4.7)
// ---------------------------------------------------------------------------

export interface SistemaAlvoApi {
  id: string;
  nome: string;
  descricao: string | null;
}

/** `GET /api/v1/sistemas-alvo` → 200. */
export interface RespostaSistemasAlvo {
  sistemas: SistemaAlvoApi[];
  /** `true` quando o tenant tem mais de um sistema ativo (criar exige escolher). */
  sistema_alvo_obrigatorio: boolean;
}

/** Anexo baixado pela API (bytes + metadados dos headers). */
export interface ArquivoBaixado {
  corpo: Buffer;
  /** Tipo pinado no upload, sem parâmetros (`; charset=…`). */
  contentType: string;
  /** `null` quando a API não informou `Content-Disposition`. */
  nomeArquivo: string | null;
}
