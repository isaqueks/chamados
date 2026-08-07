import type { ConfigMcp } from './config';

/**
 * Cliente HTTP da API `/api/v1` (specs/11 §2). É um consumidor comum: não acessa
 * banco, fila nem storage — todo poder vem do PAPEL do usuário autenticado.
 *
 * Sessão PREGUIÇOSA: o login só acontece na primeira ferramenta usada (um
 * servidor MCP é iniciado junto com o cliente e pode ficar ocioso). O token fica
 * em memória e, ao receber 401, o cliente reautentica **uma vez** e repete a
 * requisição — sessão expirada é rotina (idle de 8 h), não erro para o usuário.
 */

/** `fetch` injetável — a fronteira de rede, substituível em teste. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Erro de API já traduzido: mantém o `codigo` estável do contrato (specs/11 §6). */
export class ErroApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}

interface RespostaSessao {
  token: string;
  usuario: { id: string; nome: string; email: string; papel: string };
  tenant: { slug: string; nome_exibicao: string };
}

export interface Identidade {
  nome: string;
  email: string;
  papel: string;
  tenant: string;
}

interface OpcoesRequisicao {
  metodo?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | undefined>;
  corpo?: unknown;
}

export class ClienteChamados {
  private token: string | null = null;
  private identidade: Identidade | null = null;
  /** Login em voo — evita N logins simultâneos quando várias tools disparam juntas. */
  private loginEmCurso: Promise<void> | null = null;

  constructor(
    private readonly cfg: ConfigMcp,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  /** Identidade da sessão corrente (null antes do primeiro login). */
  quemSou(): Identidade | null {
    return this.identidade;
  }

  private headersBase(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    // Fallback de tenant para instalações onde o host não resolve (dev em
    // `localhost`) — em produção o próprio domínio identifica o tenant.
    if (this.cfg.tenantSlug) h['x-tenant-slug'] = this.cfg.tenantSlug;
    return h;
  }

  /** Abre a sessão (specs/11 §2.1). Serializa logins concorrentes. */
  private async autenticar(): Promise<void> {
    if (this.loginEmCurso) return this.loginEmCurso;
    this.loginEmCurso = (async () => {
      const resp = await this.fetchImpl(`${this.cfg.baseUrl}/api/v1/sessao`, {
        method: 'POST',
        headers: { ...this.headersBase(), 'content-type': 'application/json' },
        body: JSON.stringify({ email: this.cfg.email, senha: this.cfg.senha }),
      });
      if (!resp.ok) {
        const { codigo, erro } = await lerErro(resp);
        // A senha NUNCA entra na mensagem — só o motivo devolvido pela API.
        throw new ErroApi(
          resp.status,
          codigo,
          `Falha ao autenticar em ${this.cfg.baseUrl}: ${erro}`,
        );
      }
      const dados = (await resp.json()) as RespostaSessao;
      this.token = dados.token;
      this.identidade = {
        nome: dados.usuario.nome,
        email: dados.usuario.email,
        papel: dados.usuario.papel,
        tenant: dados.tenant.nome_exibicao,
      };
    })().finally(() => {
      this.loginEmCurso = null;
    });
    return this.loginEmCurso;
  }

  /**
   * Requisição autenticada, com renovação automática de sessão: 401 dispara UM
   * novo login e UMA repetição. Se o segundo 401 vier, é credencial errada de
   * verdade — aí o erro sobe ao modelo.
   */
  async requisitar<T>(caminho: string, opts: OpcoesRequisicao = {}): Promise<T> {
    if (!this.token) await this.autenticar();

    let resp = await this.enviar(caminho, opts);
    if (resp.status === 401) {
      this.token = null;
      await this.autenticar();
      resp = await this.enviar(caminho, opts);
    }

    if (resp.status === 204) return undefined as T;
    if (!resp.ok) {
      const { codigo, erro } = await lerErro(resp);
      throw new ErroApi(resp.status, codigo, erro);
    }
    return (await resp.json()) as T;
  }

  private enviar(caminho: string, opts: OpcoesRequisicao): Promise<Response> {
    const url = new URL(`${this.cfg.baseUrl}${caminho}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      ...this.headersBase(),
      authorization: `Bearer ${this.token ?? ''}`,
    };
    if (opts.corpo !== undefined) headers['content-type'] = 'application/json';
    return this.fetchImpl(url.toString(), {
      method: opts.metodo ?? 'GET',
      headers,
      ...(opts.corpo !== undefined ? { body: JSON.stringify(opts.corpo) } : {}),
    });
  }
}

/** Extrai `{ erro, codigo }` da resposta; tolera corpo não-JSON (proxy, 502…). */
async function lerErro(resp: Response): Promise<{ codigo: string; erro: string }> {
  try {
    const dados = (await resp.json()) as { erro?: unknown; codigo?: unknown };
    return {
      codigo: typeof dados.codigo === 'string' ? dados.codigo : `http_${resp.status}`,
      erro: typeof dados.erro === 'string' ? dados.erro : `HTTP ${resp.status}`,
    };
  } catch {
    return { codigo: `http_${resp.status}`, erro: `HTTP ${resp.status} ${resp.statusText}`.trim() };
  }
}
