/**
 * Cliente MÍNIMO da REST API do GitHub para abrir Pull Requests (specs/05 §6). A
 * IA NUNCA faz merge/deploy — só abre o PR, que fica aguardando aprovação humana
 * (guardrail inegociável, specs/09 §4). A FRONTEIRA HTTP é injetável (`fetchImpl`)
 * para teste sem rede. O token vem da credencial git decifrada do cofre e NUNCA é
 * logado — só entra no header `Authorization`.
 */

export interface RepoGithub {
  owner: string;
  repo: string;
}

/**
 * Detecta se a URL do repositório é GitHub e extrai `owner`/`repo`. Suporta
 * `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)` e URLs
 * com credencial embutida. Retorna `null` para qualquer outro host (→ PR manual).
 */
export function detectarGithub(repoUrl: string): RepoGithub | null {
  const url = repoUrl.trim();
  // Forma scp-like: git@github.com:owner/repo.git
  const scp = /^[^@]+@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url);
  if (scp) return { owner: scp[1]!, repo: scp[2]! };

  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== 'github.com') return null;
    const partes = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    if (partes.length < 2) return null;
    const owner = partes[0]!;
    const repo = partes[1]!.replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Extrai o token de uma credencial git ("user:token" | "token"). Para a API do
 * GitHub, o que importa é o token (a parte após o `:`, ou a credencial inteira).
 */
export function tokenDaCredencial(credencial: string | null): string | null {
  if (!credencial) return null;
  const idx = credencial.indexOf(':');
  const token = idx >= 0 ? credencial.slice(idx + 1) : credencial;
  return token.trim() || null;
}

/** Assinatura mínima de `fetch` que o cliente consome (injetável no teste). */
export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface OpcoesAbrirPr {
  repo: RepoGithub;
  token: string;
  branch: string;
  base: string;
  titulo: string;
  corpo: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/**
 * Abre um Pull Request via `POST /repos/{owner}/{repo}/pulls`. Devolve a `html_url`
 * do PR. Lança com motivo genérico (sem vazar token) em erro de rede/HTTP.
 */
export async function abrirPrGithub(opts: OpcoesAbrirPr): Promise<string> {
  const doFetch: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const { owner, repo } = opts.repo;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  let resp: { status: number; text(): Promise<string> };
  try {
    resp = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'chamados-agente-ia',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: opts.titulo,
        head: opts.branch,
        base: opts.base,
        body: opts.corpo,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new Error('github_pr_falhou:rede'); // nunca ecoa token/URL autenticada
  } finally {
    clearTimeout(timer);
  }

  const texto = await resp.text().catch(() => '');
  if (resp.status === 201) {
    let dados: { html_url?: string };
    try {
      dados = JSON.parse(texto) as { html_url?: string };
    } catch {
      throw new Error('github_pr_falhou:resposta_invalida');
    }
    if (!dados.html_url) throw new Error('github_pr_falhou:sem_url');
    return dados.html_url;
  }
  // Motivo curto (status), sem corpo cru que possa conter dados sensíveis.
  throw new Error(`github_pr_falhou:http_${resp.status}`);
}
