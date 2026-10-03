import {
  ROTAS_API,
  montarCaminho,
  montarQuery,
  type CodigoErroApi,
  type EntradaRota,
  type ErroApiDto,
  type NomeRota,
  type ParametrosRota,
  type SaidaRota,
} from '@comum/dto';

/**
 * Cliente tipado da API local (specs/forja/01 §4.1): chama as rotas PELO NOME
 * de `ROTAS_API` (comum/dto.ts), com parâmetros, entrada e saída tipados pelo
 * mesmo contrato que o servidor implementa.
 *
 * Autenticação: só o cookie `HttpOnly` da sessão de UI (`credentials:
 * 'same-origin'`); o navegador põe o `Origin` nos POST e o servidor confere
 * (05 §7.1). Nenhum token passa por JS.
 *
 * - 401 → a sessão de UI expirou (o servidor reiniciou): avisa os ouvintes de
 *   `aoSessaoExpirada` e a SPA mostra a página cheia "reabra pelo link impresso
 *   no terminal" (06 §1.3) — sem campo de token na página.
 * - 403 → Host/Origin recusados: erro explícito, nunca re-tentado.
 */

export class ErroApiForja extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoErroApi | 'rede',
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroApiForja';
  }

  get naoImplementado(): boolean {
    return this.codigo === 'nao_implementado';
  }
}

/** Converte a resposta de erro do servidor em `ErroApiForja` (pura; testada). */
export function interpretarErro(status: number, corpo: unknown): ErroApiForja {
  const dto = corpo as Partial<ErroApiDto> | null;
  if (dto && typeof dto === 'object' && typeof dto.erro === 'string') {
    return new ErroApiForja(status, dto.erro, dto.mensagem ?? dto.erro, dto.detalhes);
  }
  const codigo: CodigoErroApi =
    status === 401
      ? 'nao_autenticado'
      : status === 404
        ? 'nao_encontrado'
        : status === 413
          ? 'corpo_grande_demais'
          : status >= 500
            ? 'erro_interno'
            : 'entrada_invalida';
  return new ErroApiForja(status, codigo, `HTTP ${status}`);
}

type Ouvinte = () => void;
const ouvintesSessao = new Set<Ouvinte>();

export function aoSessaoExpirada(fn: Ouvinte): () => void {
  ouvintesSessao.add(fn);
  return () => {
    ouvintesSessao.delete(fn);
  };
}

type TemParametros<N extends NomeRota> = keyof ParametrosRota<N> extends never ? false : true;

export type ArgsApi<N extends NomeRota> = {
  entrada?: EntradaRota<N>;
  sinal?: AbortSignal;
} & (TemParametros<N> extends true ? { params: ParametrosRota<N> } : { params?: undefined });

/** URL de uma rota (útil para `<img src>` das rotas binárias e para o SSE). */
export function urlRota<N extends NomeRota>(
  nome: N,
  params?: ParametrosRota<N>,
  entrada?: object,
): string {
  const def = ROTAS_API[nome];
  const caminho = montarCaminho(def.caminho, (params ?? {}) as Record<string, string>);
  return def.metodo === 'GET' ? `${caminho}${montarQuery(entrada)}` : caminho;
}

export async function api<N extends NomeRota>(
  nome: N,
  ...[args]: TemParametros<N> extends true ? [ArgsApi<N>] : [ArgsApi<N>?]
): Promise<SaidaRota<N>> {
  const def = ROTAS_API[nome];
  if (def.transporte !== 'json') {
    throw new Error(`rota ${nome} é ${def.transporte}: use urlRota/sse/terminal`);
  }
  const url = urlRota(nome, args?.params as ParametrosRota<N> | undefined, args?.entrada as object);
  const comCorpo = def.metodo !== 'GET';

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: def.metodo,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(comCorpo ? { 'content-type': 'application/json' } : {}),
      },
      body: comCorpo ? JSON.stringify(args?.entrada ?? {}) : undefined,
      signal: args?.sinal,
    });
  } catch (erro) {
    if ((erro as Error)?.name === 'AbortError') throw erro;
    throw new ErroApiForja(0, 'rede', 'A Forja não respondeu (o servidor local está de pé?)');
  }

  const tipo = resposta.headers.get('content-type') ?? '';
  const corpo: unknown = tipo.includes('application/json') ? await resposta.json() : null;

  if (!resposta.ok) {
    const erro = interpretarErro(resposta.status, corpo);
    if (resposta.status === 401) for (const fn of ouvintesSessao) fn();
    throw erro;
  }
  return corpo as SaidaRota<N>;
}
