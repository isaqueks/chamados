/**
 * Validação da URL base da instalação (specs/11 §7.3; specs/forja/07 §2.3).
 *
 * Regras:
 *  - precisa ser http(s); fora de host local, **HTTPS** — a senha vai no corpo do
 *    login e o token em header;
 *  - devolve só a ORIGEM (sem caminho nem barra final): todas as rotas são
 *    absolutas a partir dela;
 *  - `127.0.0.1` é aceito, mas com AVISO: o proxy do Chamados extrai o slug do
 *    tenant do host e, com um IP de 4 rótulos, resolve o tenant `"127"` e ignora o
 *    `x-tenant-slug` → `404 tenant_desconhecido` (07 §2.3, pesquisa 02 D7). O MCP
 *    só loga o aviso (compatibilidade); a Forja recusa salvar a conexão.
 */

/** URL base inaceitável (mensagem acionável, sem segredo). */
export class ErroUrlBase extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroUrlBase';
  }
}

/** Aviso não bloqueante sobre a URL base; `codigo` estável para quem quiser recusar. */
export interface AvisoUrlBase {
  codigo: 'ip_loopback';
  mensagem: string;
}

export interface UrlBaseValidada {
  /** Origem normalizada, ex.: `https://suporte.empresa.com` ou `http://localhost:3000`. */
  origem: string;
  avisos: AvisoUrlBase[];
}

export const MENSAGEM_AVISO_IP_LOOPBACK =
  'Use "localhost" em vez de "127.0.0.1": com 127.0.0.1 o proxy resolve o tenant "127" e ' +
  'ignora o x-tenant-slug (404 tenant_desconhecido).';

export function validarBaseUrl(bruta: string): UrlBaseValidada {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new ErroUrlBase(
      `URL base inválida: "${bruta}". Use algo como https://suporte.empresa.com.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ErroUrlBase(`A URL base deve usar http ou https (recebido: ${url.protocol}).`);
  }
  const loopbackIp = url.hostname === '127.0.0.1';
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || loopbackIp;
  if (url.protocol === 'http:' && !local) {
    throw new ErroUrlBase(
      'A URL base deve ser HTTPS fora de localhost: a senha trafega no corpo do login.',
    );
  }
  const avisos: AvisoUrlBase[] = loopbackIp
    ? [{ codigo: 'ip_loopback', mensagem: MENSAGEM_AVISO_IP_LOOPBACK }]
    : [];
  return { origem: url.origin, avisos };
}
