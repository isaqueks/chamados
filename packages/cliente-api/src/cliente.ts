import { ArmazenamentoTokenMemoria, type ArmazenamentoToken } from './armazenamento-token';
import { ErroApi, ErroRede, lerErro } from './erros';
import type {
  ArquivoBaixado,
  EntradaCriarChamado,
  EntradaMensagem,
  EntradaStatus,
  FiltrosListarChamados,
  FormatoCorpo,
  Identidade,
  ItemChamado,
  PaginaChamados,
  RespostaAtribuicao,
  RespostaCriarChamado,
  RespostaDetalheChamado,
  RespostaMensagem,
  RespostaSessao,
  RespostaSilencioIa,
  RespostaSistemasAlvo,
  RespostaStatus,
} from './tipos';

/**
 * Cliente HTTP da API `/api/v1` (specs/11 §2; specs/forja/01 §5.2 e 07 §2–§3).
 * Extraído de `apps/mcp` para servir o MCP e a Forja. É um consumidor comum: não
 * acessa banco, fila nem storage — todo poder vem do PAPEL do usuário autenticado.
 *
 * Sessão PREGUIÇOSA: o login só acontece na primeira requisição sem token (o MCP
 * pode ficar ocioso; a Forja reaproveita o token persistido). Onde o token vive é
 * decisão de quem constrói (`ArmazenamentoToken`; padrão em memória). Ao receber
 * 401, o cliente reautentica **uma vez** (single-flight: chamadas concorrentes
 * esperam o MESMO login) e repete a requisição **uma vez** — sessão expirada é
 * rotina (idle de 8 h), não erro. Um segundo 401 sobe como `ErroApi`.
 *
 * Toda requisição tem prazo (`AbortController`): 30 s para JSON e 120 s para
 * anexo por padrão (07 §2.2). O prazo cobre também a leitura do corpo. Estouro
 * vira `ErroRede('timeout')`, que a Forja trata como erro de rede (07 §2.4).
 *
 * A senha é pedida a `obterSenha()` só na hora do login e nunca entra em
 * mensagem de erro; o token nunca é logado (o cliente não loga nada).
 *
 * Sessão JÁ ABERTA (`tokenInicial` — specs/11 §7.1; specs/forja FJ-030 §4): quem
 * já tem um token (a Forja repassando o da própria conexão ao MCP dos agentes)
 * entra com ele, sem login. Sem `obterSenha`, o cliente NÃO consegue relogar: um
 * 401 vira `ErroApi(401, 'sessao_recusada')` com mensagem acionável (o token
 * nunca entra nela).
 */

/** `fetch` injetável — a fronteira de rede, substituível em teste. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Prazo padrão das requisições JSON (07 §2.2). */
export const TIMEOUT_JSON_MS = 30_000;
/** Prazo padrão do download de anexo (07 §2.2). */
export const TIMEOUT_ANEXO_MS = 120_000;

export interface ConfigCliente {
  /** Origem da instalação, já validada por `validarBaseUrl` (sem barra final). */
  baseUrl: string;
  email: string;
  /**
   * Fonte da senha, consultada só no login. O MCP devolve a do env; a Forja lê
   * do keyring (e pode lançar se a senha não estiver guardada — 02 §8). Ausente
   * = só `tokenInicial`: o cliente não reloga quando a sessão cai.
   */
  obterSenha?: () => string | Promise<string>;
  /**
   * Token de uma sessão já aberta (`CHAMADOS_TOKEN` no MCP). Usado sem login; o
   * token persistido em `armazenamento`, se houver, NÃO o sobrepõe. Com 401, só
   * reloga se `obterSenha` existir.
   */
  tokenInicial?: string | null;
  /** Slug do tenant quando o host não o resolve (dev em `localhost`); `null` em produção. */
  tenantSlug: string | null;
  /** Prazo das requisições JSON (padrão `TIMEOUT_JSON_MS`). */
  timeoutMs?: number;
  /** Prazo do download de anexo (padrão `TIMEOUT_ANEXO_MS`). */
  timeoutAnexoMs?: number;
}

export interface OpcoesCliente {
  fetch?: FetchImpl;
  /** Padrão: `ArmazenamentoTokenMemoria`. */
  armazenamento?: ArmazenamentoToken;
}

/** Opções por chamada: prazo próprio e/ou cancelamento por quem chamou. */
export interface OpcoesChamada {
  timeoutMs?: number;
  sinal?: AbortSignal;
}

export interface OpcoesRequisicao extends OpcoesChamada {
  metodo?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | undefined>;
  corpo?: unknown;
}

/**
 * Extrai o nome de arquivo de um `Content-Disposition`: prefere `filename*`
 * (RFC 5987, UTF-8) e cai no `filename` ASCII. `null` se não houver.
 */
export function nomeDoContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* cai no ASCII */
    }
  }
  const ascii = /filename="?([^";]+)"?/i.exec(header);
  return ascii?.[1]?.trim() || null;
}

function csv<T extends string>(v: T | T[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const lista = Array.isArray(v) ? v : [v];
  return lista.length > 0 ? lista.join(',') : undefined;
}

/** Traduz os filtros tipados na query de `GET /api/v1/chamados` (puro, testável). */
export function queryDeFiltros(f: FiltrosListarChamados): Record<string, string | undefined> {
  return {
    status: csv(f.status),
    natureza: f.natureza,
    prioridade: f.prioridade,
    atribuicao: f.atribuicao,
    sistema_alvo_id: f.sistema_alvo_id,
    categoria_id: f.categoria_id,
    busca: f.busca,
    limite: f.limite !== undefined ? String(f.limite) : undefined,
    cursor: f.cursor,
    complexidade: csv(f.complexidade),
  };
}

/** `/api/v1/chamados/{ref}[sufixo]` com o ref codificado (`#12` exige escape). */
function caminhoChamado(ref: string, sufixo = ''): string {
  return `/api/v1/chamados/${encodeURIComponent(ref)}${sufixo}`;
}

type Tentativa<T> =
  { ok: true; valor: T } | { ok: false; status: number; codigo: string; erro: string };

export class ClienteChamados {
  private readonly fetchImpl: FetchImpl;
  private readonly armazenamento: ArmazenamentoToken;
  private token: string | null = null;
  private identidade: Identidade | null = null;
  /** Leitura única do token persistido (single-flight). */
  private carregamento: Promise<void> | null = null;
  /** Login em voo — evita N logins simultâneos quando várias chamadas disparam juntas. */
  private loginEmCurso: Promise<Identidade> | null = null;

  constructor(
    private readonly cfg: ConfigCliente,
    opcoes: OpcoesCliente = {},
  ) {
    this.fetchImpl = opcoes.fetch ?? ((url, init) => fetch(url, init));
    this.armazenamento = opcoes.armazenamento ?? new ArmazenamentoTokenMemoria();
    this.token = cfg.tokenInicial?.trim() || null;
  }

  /**
   * Identidade da sessão corrente — `null` antes do primeiro login DESTE processo
   * (um token reaproveitado do armazenamento não traz identidade; a Forja guarda
   * a sua em `conexao_chamados`).
   */
  quemSou(): Identidade | null {
    return this.identidade;
  }

  // -------------------------------------------------------------------------
  // Sessão
  // -------------------------------------------------------------------------

  /**
   * Abre uma sessão NOVA (specs/11 §2.1), grava o token no armazenamento e devolve
   * a identidade. Serializa logins concorrentes. Erros: `401 credenciais_invalidas`,
   * `429 muitas_tentativas`, `404 tenant_desconhecido` (como `ErroApi`) ou `ErroRede`.
   */
  autenticar(opts: OpcoesChamada = {}): Promise<Identidade> {
    if (this.loginEmCurso) return this.loginEmCurso;
    this.loginEmCurso = (async () => {
      if (!this.cfg.obterSenha) {
        // Modo token (FJ-030 §4): sem senha não há como abrir sessão nova. O
        // token recusado não aparece aqui — só o que fazer.
        throw new ErroApi(
          401,
          'sessao_recusada',
          `Sessão recusada por ${this.cfg.baseUrl} (token de sessão ausente, expirado ou ` +
            `revogado) e não há senha para reautenticar. Gere um token novo ou configure a senha.`,
        );
      }
      const senha = await this.cfg.obterSenha();
      const r = await this.comPrazo(
        opts.timeoutMs ?? this.timeoutJson(),
        opts.sinal,
        async (sinal) => {
          const resp = await this.fetchImpl(`${this.cfg.baseUrl}/api/v1/sessao`, {
            method: 'POST',
            headers: { ...this.headersBase(), 'content-type': 'application/json' },
            body: JSON.stringify({ email: this.cfg.email, senha }),
            signal: sinal,
          });
          if (!resp.ok)
            return { ok: false as const, status: resp.status, ...(await lerErro(resp)) };
          return { ok: true as const, valor: await lerJson<RespostaSessao>(resp) };
        },
      );
      if (!r.ok) {
        // A senha NUNCA entra na mensagem — só o motivo devolvido pela API.
        throw new ErroApi(
          r.status,
          r.codigo,
          `Falha ao autenticar em ${this.cfg.baseUrl}: ${r.erro}`,
        );
      }
      const dados = r.valor;
      this.token = dados.token;
      this.identidade = {
        id: dados.usuario.id,
        nome: dados.usuario.nome,
        email: dados.usuario.email,
        papel: dados.usuario.papel,
        tenant: dados.tenant.nome_exibicao,
        tenantSlug: dados.tenant.slug,
        expiraEm: dados.expira_em,
      };
      await this.armazenamento.gravar(dados.token, dados.expira_em);
      return this.identidade;
    })().finally(() => {
      this.loginEmCurso = null;
    });
    return this.loginEmCurso;
  }

  /**
   * Encerra a sessão no servidor (`DELETE /api/v1/sessao`, sempre 204) e apaga o
   * token local — "Desconectar"/"Trocar credencial" (07 §2.2). Não faz login para
   * isso. O token local é apagado mesmo se a rede falhar.
   */
  async encerrarSessao(opts: OpcoesChamada = {}): Promise<void> {
    await this.carregarToken();
    const token = this.token;
    try {
      if (token) {
        await this.comPrazo(opts.timeoutMs ?? this.timeoutJson(), opts.sinal, (sinal) =>
          this.fetchImpl(`${this.cfg.baseUrl}/api/v1/sessao`, {
            method: 'DELETE',
            headers: { ...this.headersBase(), authorization: `Bearer ${token}` },
            signal: sinal,
          }),
        );
      }
    } finally {
      this.token = null;
      this.identidade = null;
      await this.armazenamento.limpar();
    }
  }

  // -------------------------------------------------------------------------
  // Métodos tipados por endpoint (contratos em specs/forja/07 §3 e §11)
  // -------------------------------------------------------------------------

  /** `GET /api/v1/chamados` — uma página. */
  listarChamados(
    filtros: FiltrosListarChamados = {},
    opts: OpcoesChamada = {},
  ): Promise<PaginaChamados> {
    return this.requisitar<PaginaChamados>('/api/v1/chamados', {
      ...opts,
      query: queryDeFiltros(filtros),
    });
  }

  /**
   * Todas as páginas de `GET /api/v1/chamados` até `proximo_cursor = null` (a
   * fila da Forja — 07 §3). Para em `maxPaginas` (padrão 50) e se o servidor
   * repetir um cursor, para nunca girar em laço.
   */
  async listarTodosChamados(
    filtros: Omit<FiltrosListarChamados, 'cursor'> = {},
    opts: OpcoesChamada & { maxPaginas?: number } = {},
  ): Promise<ItemChamado[]> {
    const { maxPaginas = 50, ...opcoesChamada } = opts;
    const itens: ItemChamado[] = [];
    const vistos = new Set<string>();
    let cursor: string | undefined;
    for (let pagina = 0; pagina < maxPaginas; pagina++) {
      const r = await this.listarChamados({ ...filtros, cursor }, opcoesChamada);
      itens.push(...r.itens);
      if (!r.proximo_cursor || vistos.has(r.proximo_cursor)) break;
      vistos.add(r.proximo_cursor);
      cursor = r.proximo_cursor;
    }
    return itens;
  }

  /** `GET /api/v1/chamados/{ref}?formato=` — detalhe + timeline. `ref` = UUID ou número. */
  obterChamado(
    ref: string,
    opts: OpcoesChamada & { formato?: FormatoCorpo } = {},
  ): Promise<RespostaDetalheChamado> {
    const { formato, ...opcoesChamada } = opts;
    return this.requisitar<RespostaDetalheChamado>(caminhoChamado(ref), {
      ...opcoesChamada,
      query: { formato },
    });
  }

  /** `POST /api/v1/chamados/{ref}/mensagens` → 201 `{id}`. */
  publicarMensagem(
    ref: string,
    entrada: EntradaMensagem,
    opts: OpcoesChamada = {},
  ): Promise<RespostaMensagem> {
    return this.requisitar<RespostaMensagem>(caminhoChamado(ref, '/mensagens'), {
      ...opts,
      metodo: 'POST',
      corpo: entrada,
    });
  }

  /**
   * `POST /api/v1/chamados/{ref}/status`. NÃO idempotente: repetir o mesmo status
   * dá `409 transicao_invalida` — leia antes de escrever (07 §1.5).
   */
  mudarStatus(
    ref: string,
    entrada: EntradaStatus,
    opts: OpcoesChamada = {},
  ): Promise<RespostaStatus> {
    return this.requisitar<RespostaStatus>(caminhoChamado(ref, '/status'), {
      ...opts,
      metodo: 'POST',
      corpo: entrada,
    });
  }

  /** `POST /api/v1/chamados` → 201 `{id, numero}`. */
  criarChamado(
    entrada: EntradaCriarChamado,
    opts: OpcoesChamada = {},
  ): Promise<RespostaCriarChamado> {
    return this.requisitar<RespostaCriarChamado>('/api/v1/chamados', {
      ...opts,
      metodo: 'POST',
      corpo: entrada,
    });
  }

  /** `GET /api/v1/sistemas-alvo`. */
  listarSistemasAlvo(opts: OpcoesChamada = {}): Promise<RespostaSistemasAlvo> {
    return this.requisitar<RespostaSistemasAlvo>('/api/v1/sistemas-alvo', opts);
  }

  /** `GET /api/v1/anexos/{id}` — bytes (prazo de anexo). `404 anexo_inexistente` se negado. */
  baixarAnexo(id: string, opts: OpcoesChamada = {}): Promise<ArquivoBaixado> {
    return this.requisitarBytes(`/api/v1/anexos/${encodeURIComponent(id)}`, opts);
  }

  /**
   * D-036 L1 — `POST /api/v1/chamados/{ref}/ia` (idempotente). Só existe após o
   * deploy da D-036: antes, a rota inexistente responde `ErroApi` `http_404`.
   */
  definirSilencioIa(
    ref: string,
    silenciada: boolean,
    opts: OpcoesChamada = {},
  ): Promise<RespostaSilencioIa> {
    return this.requisitar<RespostaSilencioIa>(caminhoChamado(ref, '/ia'), {
      ...opts,
      metodo: 'POST',
      corpo: { silenciada },
    });
  }

  /**
   * D-036 L4 — `POST /api/v1/chamados/{ref}/atribuicao` (`null` desatribui). NÃO
   * idempotente no servidor (cada chamada gera evento): chame só quando o valor
   * muda (07 §11.4). Antes do deploy da D-036 responde `http_404`.
   */
  atribuir(
    ref: string,
    operadorId: string | null,
    opts: OpcoesChamada = {},
  ): Promise<RespostaAtribuicao> {
    return this.requisitar<RespostaAtribuicao>(caminhoChamado(ref, '/atribuicao'), {
      ...opts,
      metodo: 'POST',
      corpo: { operador_id: operadorId },
    });
  }

  // -------------------------------------------------------------------------
  // Genéricos (o MCP usa estes; os tipados acima se apoiam neles)
  // -------------------------------------------------------------------------

  /**
   * Requisição autenticada que devolve o JSON (ou `undefined` em 204), com
   * renovação automática de sessão no 401.
   */
  requisitar<T>(caminho: string, opts: OpcoesRequisicao = {}): Promise<T> {
    return this.executar(caminho, opts, this.timeoutJson(), async (resp) =>
      resp.status === 204 ? (undefined as T) : await lerJson<T>(resp),
    );
  }

  /**
   * Como `requisitar`, mas devolve os BYTES (anexos — specs/11 §4.7). O nome do
   * arquivo vem do `Content-Disposition` que a API monta; o tipo é o pinado no
   * upload. Erros continuam chegando como `ErroApi` (a API responde JSON neles).
   */
  requisitarBytes(caminho: string, opts: OpcoesChamada = {}): Promise<ArquivoBaixado> {
    return this.executar(
      caminho,
      opts,
      this.cfg.timeoutAnexoMs ?? TIMEOUT_ANEXO_MS,
      async (resp) => ({
        corpo: Buffer.from(await resp.arrayBuffer()),
        contentType: (resp.headers.get('content-type') ?? 'application/octet-stream')
          .split(';')[0]!
          .trim(),
        nomeArquivo: nomeDoContentDisposition(resp.headers.get('content-disposition')),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private timeoutJson(): number {
    return this.cfg.timeoutMs ?? TIMEOUT_JSON_MS;
  }

  private headersBase(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    // Fallback de tenant para instalações onde o host não resolve (dev em
    // `localhost`) — em produção o próprio domínio identifica o tenant.
    if (this.cfg.tenantSlug) h['x-tenant-slug'] = this.cfg.tenantSlug;
    return h;
  }

  /** Carrega o token persistido UMA vez por instância. */
  private carregarToken(): Promise<void> {
    this.carregamento ??= (async () => {
      const salvo = await this.armazenamento.ler();
      if (salvo && !this.token) this.token = salvo;
    })();
    return this.carregamento;
  }

  /**
   * Token utilizável: memória → armazenamento → login. O login implícito NÃO herda
   * o `sinal` de quem chamou: ele é compartilhado (single-flight) e cancelar uma
   * chamada não pode derrubar o login que as outras esperam.
   */
  private async tokenAtual(): Promise<string> {
    await this.carregarToken();
    if (!this.token) await this.autenticar();
    return this.token!;
  }

  /**
   * O servidor recusou `tokenUsado`. Se outra chamada já renovou nesse meio-tempo,
   * só reaproveita o token novo; senão apaga o recusado e faz (ou espera) o login.
   */
  private async renovar(tokenUsado: string): Promise<string> {
    if (this.token && this.token !== tokenUsado) return this.token;
    if (this.token === tokenUsado) {
      this.token = null;
      await this.armazenamento.limpar();
    }
    await this.autenticar();
    return this.token!;
  }

  /**
   * Núcleo: envia com o token atual; em 401, renova UMA vez e repete UMA vez. Se
   * o segundo 401 vier, é credencial/sessão recusada de verdade — o erro sobe.
   */
  private async executar<T>(
    caminho: string,
    opts: OpcoesRequisicao,
    timeoutPadrao: number,
    ler: (resp: Response) => Promise<T>,
  ): Promise<T> {
    const prazo = opts.timeoutMs ?? timeoutPadrao;
    let token = await this.tokenAtual();
    let r = await this.tentar(caminho, opts, token, prazo, ler);
    if (!r.ok && r.status === 401) {
      token = await this.renovar(token);
      r = await this.tentar(caminho, opts, token, prazo, ler);
    }
    if (!r.ok) throw new ErroApi(r.status, r.codigo, r.erro);
    return r.valor;
  }

  /** Uma ida ao servidor, com o prazo cobrindo envio E leitura do corpo. */
  private tentar<T>(
    caminho: string,
    opts: OpcoesRequisicao,
    token: string,
    prazo: number,
    ler: (resp: Response) => Promise<T>,
  ): Promise<Tentativa<T>> {
    const url = new URL(`${this.cfg.baseUrl}${caminho}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      ...this.headersBase(),
      authorization: `Bearer ${token}`,
    };
    if (opts.corpo !== undefined) headers['content-type'] = 'application/json';

    return this.comPrazo(prazo, opts.sinal, async (sinal): Promise<Tentativa<T>> => {
      const resp = await this.fetchImpl(url.toString(), {
        method: opts.metodo ?? 'GET',
        headers,
        ...(opts.corpo !== undefined ? { body: JSON.stringify(opts.corpo) } : {}),
        signal: sinal,
      });
      if (!resp.ok) return { ok: false, status: resp.status, ...(await lerErro(resp)) };
      return { ok: true, valor: await ler(resp) };
    });
  }

  /**
   * Executa `fn` sob um `AbortController` com prazo `ms`, encadeado ao `sinal` de
   * quem chamou. Falha sem resposta HTTP vira `ErroRede` (timeout/abortado/rede);
   * `ErroApi` passa intacto.
   */
  private async comPrazo<T>(
    ms: number,
    sinalExterno: AbortSignal | undefined,
    fn: (sinal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (sinalExterno?.aborted) {
      throw new ErroRede('abortado', `Requisição a ${this.cfg.baseUrl} cancelada.`);
    }
    const ctrl = new AbortController();
    let estourou = false;
    const timer = setTimeout(() => {
      estourou = true;
      ctrl.abort();
    }, ms);
    const repassar = (): void => ctrl.abort();
    sinalExterno?.addEventListener('abort', repassar, { once: true });
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      if (e instanceof ErroApi || e instanceof ErroRede) throw e;
      if (estourou) {
        throw new ErroRede('timeout', `Sem resposta de ${this.cfg.baseUrl} em ${ms} ms.`, {
          cause: e,
        });
      }
      if (sinalExterno?.aborted) {
        throw new ErroRede('abortado', `Requisição a ${this.cfg.baseUrl} cancelada.`, { cause: e });
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new ErroRede('rede', `Falha de rede ao acessar ${this.cfg.baseUrl}: ${msg}`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      sinalExterno?.removeEventListener('abort', repassar);
    }
  }
}

/** JSON de uma resposta 2xx; corpo ilegível vira `ErroApi` `resposta_invalida` (não "rede"). */
async function lerJson<T>(resp: Response): Promise<T> {
  const texto = await resp.text();
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new ErroApi(
      resp.status,
      'resposta_invalida',
      `Resposta HTTP ${resp.status} sem JSON válido.`,
    );
  }
}
