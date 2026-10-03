/**
 * Erros do cliente da API `/api/v1` (specs/forja/07 §2.4; specs/11 §6).
 *
 * Duas famílias, porque a reação de quem consome é diferente:
 *  - `ErroApi`: o servidor RESPONDEU com erro. Carrega o `status` HTTP e o
 *    `codigo` estável do contrato (`transicao_invalida`, `estado_terminal`…) — é
 *    por ele que o MCP devolve um erro corrigível ao modelo e que a Forja decide
 *    a reação (spec 07 §2.4), nunca pelo texto.
 *  - `ErroRede`: NÃO houve resposta (timeout, conexão recusada, abort externo).
 *    Para a Forja é "5xx/rede/timeout" → backoff (spec 07 §2.4, última linha).
 */

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

/** Motivo de uma falha sem resposta do servidor. */
export type CodigoErroRede = 'timeout' | 'rede' | 'abortado';

/** Falha sem resposta HTTP: timeout do `AbortController`, rede ou abort de quem chamou. */
export class ErroRede extends Error {
  constructor(
    readonly codigo: CodigoErroRede,
    mensagem: string,
    options?: { cause?: unknown },
  ) {
    super(mensagem, options);
    this.name = 'ErroRede';
  }
}

/**
 * Extrai `{ erro, codigo }` da resposta de erro; tolera corpo não-JSON (proxy,
 * 502, 404 HTML do Next para rota inexistente…) caindo em `http_<status>`.
 */
export async function lerErro(resp: Response): Promise<{ codigo: string; erro: string }> {
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
