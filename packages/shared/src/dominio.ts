/**
 * Validação de domínio próprio do tenant (specs/07 §3.4, E-08) — puro/testável.
 *
 * Regras: hostname absoluto válido (sem esquema, porta, caminho ou credenciais),
 * ao menos dois rótulos (tem ponto), rótulos `[a-z0-9-]` sem hífen nas pontas,
 * TLD só letras. Domínios de plataforma/reservados são recusados para não
 * colidir com a resolução por subdomínio.
 */

/** Sufixos que pertencem à plataforma ou ao dev; não podem ser domínio próprio. */
const SUFIXOS_RESERVADOS = ['chamados.app', 'localhost'];

/** Hostnames reservados exatos. */
const HOSTS_RESERVADOS = new Set(['localhost']);

/** Normaliza um domínio para comparação/armazenamento (minúsculo, sem espaços). */
export function normalizarDominio(dominio: string): string {
  return dominio.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * O domínio próprio informado é válido? Não valida DNS/propriedade — só formato
 * e reservados. A unicidade global é garantida pela constraint no banco.
 */
export function dominioProprioValido(dominio: string): boolean {
  const d = normalizarDominio(dominio);
  if (d.length === 0 || d.length > 253) return false;
  if (HOSTS_RESERVADOS.has(d)) return false;
  // Sem esquema, porta, caminho, espaço, arroba, barra.
  if (/[\s/@:?#]/.test(d)) return false;

  const rotulos = d.split('.');
  if (rotulos.length < 2) return false; // precisa de ao menos um ponto

  for (const r of rotulos) {
    if (r.length === 0 || r.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(r)) return false;
    if (r.startsWith('-') || r.endsWith('-')) return false;
  }

  // TLD só letras (>= 2).
  const tld = rotulos[rotulos.length - 1]!;
  if (!/^[a-z]{2,}$/.test(tld)) return false;

  // Não pode ser (ou estar sob) um sufixo reservado da plataforma.
  for (const suf of SUFIXOS_RESERVADOS) {
    if (d === suf || d.endsWith(`.${suf}`)) return false;
  }

  return true;
}

/**
 * URL do repositório git de um SistemaAlvo (specs/07 §5.1). Aceita `https://`
 * e SSH (`git@host:org/repo.git` ou `ssh://`). Puro/testável.
 */
export function repoUrlValida(url: string): boolean {
  const u = url.trim();
  if (u.length === 0 || u.length > 2048) return false;
  // SSH curto: git@host:caminho
  if (/^[a-z0-9._-]+@[a-z0-9.-]+:[^\s]+$/i.test(u)) return true;
  try {
    const parsed = new URL(u);
    return (
      parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'ssh:'
    );
  } catch {
    return false;
  }
}

/**
 * O caminho informado é um repositório LOCAL de formato válido (D-011)? Aceita
 * caminho absoluto do Windows (`X:\...` ou `X:/...`), absoluto POSIX (`/...`) e
 * `file://`. Recusa relativos, vazios e acima de 2048 chars. Puro/testável.
 *
 * NÃO verifica existência no disco — só o formato. O gate de PERMISSÃO (a flag
 * `SISTEMAS_PERMITIR_REPO_LOCAL`) fica no serviço server-side, nunca nesta função
 * pura (que também roda no cliente).
 */
export function repoLocalValido(caminho: string): boolean {
  const c = (caminho ?? '').trim();
  if (c.length === 0 || c.length > 2048) return false;
  // file:// (Windows: file:///C:/… ; POSIX: file:///…) — precisa de algo após.
  if (/^file:\/\/./i.test(c)) return true;
  // Absoluto Windows: letra de unidade + ':' + barra ou contrabarra.
  if (/^[a-zA-Z]:[\\/]/.test(c)) return true;
  // Absoluto POSIX: começa com '/'.
  if (c.startsWith('/')) return true;
  return false;
}

/** Motivo de recusa da validação de repositório de um SistemaAlvo. */
export type MotivoRepoSistema = 'invalido' | 'local_desabilitado';

/** Resultado da validação combinada (remoto | local-atrás-de-flag) do repo. */
export interface ResultadoRepoSistema {
  ok: boolean;
  /** O caminho tem formato de repositório LOCAL (mesmo quando recusado pela flag). */
  local: boolean;
  motivo?: MotivoRepoSistema;
}

/**
 * Valida o `git_repo_url` de um SistemaAlvo considerando a permissão de repo
 * LOCAL (D-011). Remoto (`https`/SSH) é sempre aceito; caminho local só quando
 * `permitirLocal` (a flag `SISTEMAS_PERMITIR_REPO_LOCAL`, lida server-side). Puro
 * para poder ser usado tanto no cliente (form) quanto no servidor (service).
 */
export function validarRepoSistema(
  url: string,
  opts: { permitirLocal: boolean },
): ResultadoRepoSistema {
  const u = (url ?? '').trim();
  if (repoLocalValido(u)) {
    return opts.permitirLocal
      ? { ok: true, local: true }
      : { ok: false, local: true, motivo: 'local_desabilitado' };
  }
  if (repoUrlValida(u)) return { ok: true, local: false };
  return { ok: false, local: false, motivo: 'invalido' };
}
