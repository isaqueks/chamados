/**
 * Deep links entre áreas e pós-login (correção de 2026-07-22): abrir um link
 * direto de chamado precisa cair NO CHAMADO — não na raiz da área. Três buracos
 * cobertos: (a) operador/admin abrindo link do portal (e vice-versa) era jogado
 * na raiz da outra área; (b) deslogado, o destino se perdia no /login. O proxy
 * injeta o caminho da requisição em `x-caminho` (Edge, sempre sobrescreve —
 * imune a spoofing) e estes helpers validam/mapeiam.
 *
 * Módulo PURO (sem server-only) para ser testável; quem lê o header é o
 * chamador (layouts/guards, via `headers()`).
 */

/** Header injetado pelo proxy com `pathname + search` da requisição. */
export const HEADER_CAMINHO = 'x-caminho';

/**
 * Valida um destino de redirect INTERNO pós-autenticação: precisa começar com
 * `/` único (nunca `//host` nem `/\` — open redirect), não conter caractere de
 * controle e não apontar para `/login` (um `next=/login` craftado criaria loop
 * de redirect com a página logada). Devolve o caminho ou `null` se inválido.
 */
export function caminhoSeguro(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const v = valor.trim();
  if (!v.startsWith('/')) return null;
  if (v.startsWith('//') || v.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(v)) return null;
  if (v === '/login' || v.startsWith('/login?') || v.startsWith('/login/')) return null;
  return v;
}

const RE_CHAMADO =
  /^\/(app|portal)\/chamados\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/)?(?:\?.*)?$/i;

/**
 * Mapeia um caminho para a MESMA página na outra área quando existe equivalente
 * direto — hoje, a página do chamado (`/portal/chamados/<id>` ↔
 * `/app/chamados/<id>`). Sem equivalente, devolve a raiz da área destino.
 */
export function equivalenteNaArea(caminho: string | null, area: 'app' | 'portal'): string {
  const m = caminho ? RE_CHAMADO.exec(caminho) : null;
  if (m) return `/${area}/chamados/${m[2]!.toLowerCase()}`;
  return `/${area}`;
}

/** Monta a URL do /login preservando o destino (só caminhos internos válidos). */
export function urlLoginCom(destino: string | null): string {
  const seguro = caminhoSeguro(destino);
  // Raiz não vale a pena preservar (/login inválido já cai no caminhoSeguro).
  if (!seguro || seguro === '/') return '/login';
  return `/login?next=${encodeURIComponent(seguro)}`;
}
