import { ehTerminal, transicaoValida, type StatusChamado } from '@chamados/shared';
import {
  ArmazenamentoTokenMemoria,
  ClienteChamados,
  type DetalheChamado,
  type FetchImpl,
  type ItemChamado,
  type MensagemChamado,
} from '@chamados/cliente-api';

/**
 * Chamados FALSO para os testes de `server/chamados`: um `fetch` que responde
 * às rotas de `/api/v1` usadas pela Forja, com o contrato real de erros
 * (specs/forja/07 §2.4) e a máquina de estados de `@chamados/shared` — repetir o
 * mesmo status dá `409 transicao_invalida`, terminal dá `409 estado_terminal`,
 * aresta do `sistema` dá `403 sem_permissao`. Nenhum teste toca a rede.
 */

export interface ChamadoFalso {
  detalhe: DetalheChamado;
  mensagens: MensagemChamado[];
}

export interface Requisicao {
  metodo: string;
  caminho: string;
  query: URLSearchParams;
  corpo: unknown;
  auth: string | undefined;
}

type Interceptor = (r: Requisicao) => Response | null | undefined;

export function json(dados: unknown, status = 200): Response {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const erro = (status: number, codigo: string): Response =>
  json({ erro: `erro ${codigo}`, codigo }, status);

let seq = 0;

export function itemFalso(p: Partial<ItemChamado> & { numero: number }): ItemChamado {
  return {
    id: p.id ?? `uuid-${p.numero}`,
    titulo: `Chamado ${p.numero}`,
    status: 'em_atendimento',
    natureza: 'alteracao',
    prioridade: 'media',
    complexidade: 'facil',
    operador_nome: null,
    solicitante_nome: 'Maria Souza',
    sistema_nome: 'ERP',
    categoria_nome: null,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

export function detalheFalso(p: Partial<DetalheChamado> & { numero: number }): DetalheChamado {
  return {
    ...itemFalso(p),
    descricao: 'Descrição',
    formato: 'markdown',
    anexos: [],
    ia_silenciada: true,
    resolvido_em: null,
    fechar_automaticamente_em: null,
    fechado_em: null,
    reaberto_count: 0,
    ...p,
  };
}

export function mensagemFalsa(p: Partial<MensagemChamado> & { corpo: string }): MensagemChamado {
  seq += 1;
  return {
    id: `m-${seq}`,
    autor_nome: 'Maria Souza',
    autor_papel: 'cliente',
    visibilidade: 'publica',
    anexos: [],
    created_at: '2026-10-02T12:00:00.000Z',
    ...p,
  };
}

export class ChamadosFalso {
  chamados = new Map<string, ChamadoFalso>();
  /** Itens da lista (`GET /chamados`), quando o teste quer controlar a lista à parte. */
  lista: ItemChamado[] | null = null;
  requisicoes: Requisicao[] = [];
  interceptores: Interceptor[] = [];
  d036 = true;
  usuario = {
    id: 'u-forja',
    nome: 'Equipe de Suporte',
    email: 'forja@acme.com',
    papel: 'operador',
  };
  tokensValidos = new Set<string>();
  senhaCorreta = 'senha-certa';
  logins = 0;
  agora = '2026-10-02T12:30:00.000Z';

  adicionar(c: ChamadoFalso): this {
    this.chamados.set(c.detalhe.id, c);
    return this;
  }

  escritas(): Requisicao[] {
    return this.requisicoes.filter((r) => r.metodo === 'POST' && !r.caminho.endsWith('/sessao'));
  }

  cliente(): ClienteChamados {
    const arm = new ArmazenamentoTokenMemoria();
    void arm.gravar('tok-inicial', this.agora);
    this.tokensValidos.add('tok-inicial');
    return new ClienteChamados(
      {
        baseUrl: 'https://suporte.acme.com',
        email: 'forja@acme.com',
        obterSenha: () => this.senhaCorreta,
        tenantSlug: null,
      },
      { fetch: this.fetch, armazenamento: arm },
    );
  }

  fetch: FetchImpl = async (url, init) => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: Requisicao = {
      metodo: init?.method ?? 'GET',
      caminho: u.pathname,
      query: u.searchParams,
      corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers.authorization,
    };
    this.requisicoes.push(req);
    for (const i of this.interceptores) {
      const r = i(req);
      if (r) return r;
    }
    return this.rotear(req);
  };

  private rotear(r: Requisicao): Response {
    if (r.caminho === '/api/v1/sessao' && r.metodo === 'POST') {
      this.logins += 1;
      const { senha } = r.corpo as { senha: string };
      if (senha !== this.senhaCorreta) return erro(401, 'credenciais_invalidas');
      const token = `tok-${this.logins}`;
      this.tokensValidos.add(token);
      return json({
        token,
        expira_em: '2026-10-02T20:00:00.000Z',
        usuario: this.usuario,
        tenant: { slug: 'acme', nome_exibicao: 'ACME' },
      });
    }
    const token = r.auth?.replace(/^Bearer /, '');
    if (!token || !this.tokensValidos.has(token)) return erro(401, 'nao_autenticado');

    if (r.caminho === '/api/v1/sistemas-alvo') {
      return json({
        sistemas: [{ id: 's-erp', nome: 'ERP', descricao: null }],
        sistema_alvo_obrigatorio: false,
      });
    }
    if (r.caminho === '/api/v1/chamados' && r.metodo === 'GET') return this.listar(r);

    const m = /^\/api\/v1\/chamados\/([^/]+)(\/[a-z]+)?$/.exec(r.caminho);
    if (!m) return erro(404, 'http_404');
    const c = this.chamados.get(decodeURIComponent(m[1]!));
    const sufixo = m[2] ?? '';
    if ((sufixo === '/ia' || sufixo === '/atribuicao') && !this.d036) {
      return new Response('<html>404</html>', { status: 404 });
    }
    if (!c) return erro(404, 'chamado_inexistente');
    const d = c.detalhe;

    if (!sufixo && r.metodo === 'GET') {
      const detalhe: DetalheChamado = { ...d };
      if (!this.d036) {
        delete detalhe.operador_id;
        delete detalhe.sistema_alvo_id;
      }
      return json({ chamado: detalhe, mensagens: c.mensagens });
    }
    if (sufixo === '/mensagens') {
      if (ehTerminal(d.status)) return erro(409, 'estado_terminal');
      const corpo = r.corpo as { visibilidade: 'publica' | 'interna'; corpo: string };
      const msg = mensagemFalsa({
        corpo: corpo.corpo,
        visibilidade: corpo.visibilidade,
        autor_nome: this.usuario.nome,
        autor_papel: 'operador',
        created_at: this.agora,
      });
      c.mensagens.push(msg);
      return json({ id: msg.id }, 201);
    }
    if (sufixo === '/status') {
      const para = (r.corpo as { status: StatusChamado }).status;
      const t = transicaoValida('operador', d.status, para);
      if (!t.ok) {
        if (t.motivo === 'mesmo_status' || t.motivo === 'transicao_inexistente') {
          return erro(409, 'transicao_invalida');
        }
        if (t.motivo === 'estado_terminal') return erro(409, 'estado_terminal');
        return erro(403, 'sem_permissao');
      }
      d.status = para;
      return json({ status: para });
    }
    if (sufixo === '/ia') {
      if (ehTerminal(d.status)) return erro(409, 'estado_terminal');
      d.ia_silenciada = (r.corpo as { silenciada: boolean }).silenciada;
      return json({ ia_silenciada: d.ia_silenciada });
    }
    if (sufixo === '/atribuicao') {
      if (ehTerminal(d.status)) return erro(409, 'estado_terminal');
      d.operador_id = (r.corpo as { operador_id: string | null }).operador_id;
      return json({ operador_id: d.operador_id });
    }
    return erro(404, 'http_404');
  }

  private listar(r: Requisicao): Response {
    let itens: ItemChamado[] =
      this.lista ??
      [...this.chamados.values()].map((c) => {
        const { descricao: _d, formato: _f, anexos: _a, ...item } = c.detalhe;
        return item as ItemChamado;
      });
    const status = r.query.get('status')?.split(',');
    const natureza = r.query.get('natureza');
    if (status) itens = itens.filter((i) => status.includes(i.status));
    if (natureza) itens = itens.filter((i) => i.natureza === natureza);
    if (!this.d036) itens = itens.map(({ ia_silenciada: _i, ...resto }) => resto as ItemChamado);
    const limite = Number(r.query.get('limite') ?? '20');
    const inicio = Number(r.query.get('cursor') ?? '0');
    const pagina = itens.slice(inicio, inicio + limite);
    const prox = inicio + limite < itens.length ? String(inicio + limite) : null;
    return json({ itens: pagina, proximo_cursor: prox });
  }
}
