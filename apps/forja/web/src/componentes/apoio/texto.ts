import type { ErroApiForja } from '../../lib/api';

/**
 * Formatação pura das telas de apoio (specs/forja/06 §4.4–§4.11): sha/patch
 * curtos, bytes, datas em pt-BR e a mensagem legível de um erro da API local.
 *
 * POR QUE aqui e não em `lib/formato.ts`: `lib/*` é compartilhado pelo shell e
 * pelas telas principais; estas funções só servem às telas de apoio e ficam
 * ao lado delas (sem dependência de DOM, testadas em `texto.test.ts`).
 */

/** Sha ou `patch-id` com 7 caracteres ("4f9a1c2"), como no `git log --oneline`. */
export function shaCurto(sha: string | null | undefined, tamanho = 7): string {
  if (!sha) return '—';
  return sha.slice(0, tamanho);
}

const UNIDADES = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1536 → "1,5 KB" (base 1024, uma casa decimal a partir de KB). */
export function formatarBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  let valor = bytes;
  let i = 0;
  while (valor >= 1024 && i < UNIDADES.length - 1) {
    valor /= 1024;
    i += 1;
  }
  const casas = i === 0 ? 0 : 1;
  const texto = valor.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
  return `${texto} ${UNIDADES[i]}`;
}

/** "02/10 14:05" no fuso local; ano só quando difere do atual. */
export function formatarDataHora(iso: string | null | undefined, agora: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mesmoAno = d.getFullYear() === agora.getFullYear();
  const data = d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    ...(mesmoAno ? {} : { year: 'numeric' }),
  });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${data} ${hora}`;
}

/** "há 40 s", "há 5 min", "há 3 h", "há 2 dias" (passado) — nunca negativo. */
export function formatarRelativo(iso: string | null | undefined, agora: Date = new Date()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((agora.getTime() - t) / 1000));
  if (s < 60) return `há ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  const dias = Math.floor(h / 24);
  return `há ${dias} dias`;
}

/** Cronômetro "2:10" (min:seg) ou "1:02:10" desde `iso`; usado em "planejando 2:10". */
export function formatarDecorrido(
  iso: string | null | undefined,
  agora: Date = new Date(),
): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const total = Math.max(0, Math.floor((agora.getTime() - t) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1 chamado" / "3 chamados". */
export function plural(n: number, singular: string, pluralTexto?: string): string {
  return `${n} ${n === 1 ? singular : (pluralTexto ?? `${singular}s`)}`;
}

/**
 * Texto do erro para a tela (06 §6 item 9: "erros dizem a causa e a ação";
 * stack trace nunca). `nao_implementado` (501) vira um aviso neutro: a rota
 * existe no contrato mas o servidor ainda não a atende.
 */
export function mensagemErro(erro: unknown): string {
  const e = erro as Partial<ErroApiForja> | null;
  if (e && typeof e === 'object' && typeof e.codigo === 'string') {
    if (e.codigo === 'nao_implementado')
      return 'Esta função ainda não está disponível no servidor local.';
    if (e.codigo === 'rede') return 'A Forja não respondeu. O servidor local está de pé?';
    if (e.codigo === 'patch_id_divergente') {
      return 'O patch mudou desde que esta tela abriu: recarregue e revise de novo.';
    }
    if (e.codigo === 'chamados_indisponivel') {
      return 'O Chamados não respondeu. Tente de novo em instantes.';
    }
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  if (erro instanceof Error && erro.message) return erro.message;
  return 'Erro inesperado.';
}
