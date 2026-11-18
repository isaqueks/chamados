import { StatusChamado, STATUS_ABERTOS, STATUS_ENCERRADOS } from '@chamados/shared';

/**
 * Recorte da lista do portal (`/portal`) ↔ URL — fonte única para a página e
 * para a exportação Excel do portal (D-045), que precisa listar EXATAMENTE o
 * que a tela mostra. Puro.
 *
 * - `ver`: `meus` (padrão) | `todos` — recorte por solicitante (D-037);
 * - `aba`: `abertos` (padrão) | `historico` — grupos canônicos de D-030;
 * - `status`: um status DENTRO do grupo da aba (fora dele é ignorado);
 * - `q`: busca textual; quando presente varre abertos + histórico (specs/04 §10.4).
 */

export type AbaPortal = 'abertos' | 'historico';
export type RecortePortal = 'meus' | 'todos';

export interface EstadoListaPortal {
  ver: RecortePortal;
  aba: AbaPortal;
  grupo: readonly StatusChamado[];
  statusFiltro?: StatusChamado;
  busca: string;
  cursor?: string;
}

type Bruto = URLSearchParams | Record<string, string | string[] | undefined>;

function ler(sp: Bruto, chave: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(chave) ?? undefined;
  const v = sp[chave];
  return Array.isArray(v) ? v[0] : v;
}

function ehStatus(v: string | undefined): v is StatusChamado {
  return !!v && (Object.values(StatusChamado) as string[]).includes(v);
}

export function lerListaPortal(sp: Bruto): EstadoListaPortal {
  const ver: RecortePortal = ler(sp, 'ver') === 'todos' ? 'todos' : 'meus';
  const aba: AbaPortal = ler(sp, 'aba') === 'historico' ? 'historico' : 'abertos';
  const grupo = aba === 'historico' ? STATUS_ENCERRADOS : STATUS_ABERTOS;
  const s = ler(sp, 'status');
  const statusFiltro = ehStatus(s) && grupo.includes(s) ? s : undefined;
  const cursor = ler(sp, 'cursor') || undefined;
  const busca = (ler(sp, 'q') ?? '').trim().slice(0, 200);
  return { ver, aba, grupo, statusFiltro, busca, cursor };
}

/** Status consultados: com busca, todos (varre o histórico); senão o filtro ou o grupo. */
export function statusConsultadosPortal(e: EstadoListaPortal): StatusChamado[] | undefined {
  if (e.busca) return undefined;
  return e.statusFiltro ? [e.statusFiltro] : [...e.grupo];
}

/** Href de `/portal` preservando só os parâmetros informados. */
export function hrefPortal(
  params: {
    ver?: RecortePortal;
    aba?: AbaPortal;
    status?: StatusChamado;
    cursor?: string;
    q?: string;
  },
  base = '/portal',
): string {
  const sp = new URLSearchParams();
  if (params.ver === 'todos') sp.set('ver', 'todos');
  if (params.q) sp.set('q', params.q);
  if (params.aba && params.aba !== 'abertos') sp.set('aba', params.aba);
  if (params.status) sp.set('status', params.status);
  if (params.cursor) sp.set('cursor', params.cursor);
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Href da exportação Excel do portal para o MESMO recorte (sem cursor: exporta tudo). */
export function hrefExportacaoPortal(e: EstadoListaPortal): string {
  return hrefPortal(
    { ver: e.ver, aba: e.aba, status: e.statusFiltro, q: e.busca || undefined },
    '/portal/exportar',
  );
}
