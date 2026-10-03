import type { ChaveNoTrilha, EstadoNoTrilha } from '@comum/dto';
import type { PapelAgente } from '@comum/estados';

/**
 * Formatação pura da tela de Execução (specs/forja/06 §4.2): rótulos da
 * trilha, duração dos nós, hora das linhas do feed, nome curto do modelo
 * ("Fable"/"Opus", de `modelUsage`) e o marcador de ciclos de retrabalho.
 */

export const ROTULO_NO_TRILHA: Record<ChaveNoTrilha, string> = {
  preparar: 'Preparar',
  planejar: 'Planejar',
  decisao: 'Decisão',
  implementar: 'Implementar',
  verificar: 'Coleta',
  revisar: 'Revisar',
  relatar: 'Relatar',
  aprovacao: 'Aprovação',
  merge: 'Merge',
  chamados: 'Chamados',
};

export const ROTULO_ESTADO_NO: Record<EstadoNoTrilha, string> = {
  pendente: 'pendente',
  atual: 'em andamento',
  feito: 'concluído',
  falhou: 'falhou',
  pulado: 'pulado',
};

/** 45 s · 18 min · 1 h 05 min. */
export function formatarDuracao(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Duração desde `inicio` até `fim` (ou agora). */
export function duracaoEntre(
  inicio: string | null,
  fim: string | null,
  agora = new Date(),
): number | null {
  if (!inicio) return null;
  const a = Date.parse(inicio);
  const b = fim ? Date.parse(fim) : agora.getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

/** "10:02:13" no fuso local. */
export function horaFeed(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** `claude-opus-5-5` → "Opus"; `claude-fable-5-1` → "Fable"; desconhecido → o id. */
export function nomeModelo(modelo: string | null | undefined): string | null {
  if (!modelo) return null;
  const m = modelo.toLowerCase();
  for (const nome of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (m.includes(nome)) return nome[0]!.toUpperCase() + nome.slice(1);
  }
  return modelo;
}

/** Quem fala na thread principal: planejador e condutor são o Fable (00 §7). */
export function autorPrincipal(papel: PapelAgente | null): string {
  if (!papel || papel === 'planejador' || papel === 'condutor') return 'Fable';
  return papel;
}

/** "ciclo 1/2 auto · total 2/5" — só aparece quando já houve retrabalho. */
export function textoCiclos(
  auto: number,
  total: number,
  limites: { max_auto: number; max_total: number },
): string | null {
  if (total <= 0 && auto <= 0) return null;
  return `ciclo ${auto}/${limites.max_auto} auto · total ${total}/${limites.max_total}`;
}
