/**
 * Formatação de datas/tempo em pt-BR para a UI (specs/08 — microcopy consistente).
 * Puro e determinístico; usado tanto em Server Components quanto em Client.
 */

const fmtDataHora = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

const fmtData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });

/** Data + hora curtas (ex.: 15/07/2026 14:02). */
export function dataHora(valor: Date | string): string {
  return fmtDataHora.format(new Date(valor));
}

/** Só a data (ex.: 15 de jul. de 2026). */
export function data(valor: Date | string): string {
  return fmtData.format(new Date(valor));
}

/**
 * Tempo relativo compacto e amigável (ex.: "agora", "há 5 min", "há 2 h",
 * "há 3 dias"). Sempre no passado no nosso uso (timeline/atualização).
 */
export function tempoRelativo(valor: Date | string): string {
  const then = new Date(valor).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return '';
  const seg = Math.max(0, Math.floor(diff / 1000));
  if (seg < 45) return 'agora';
  const min = Math.floor(seg / 60);
  if (min < 60) return `há ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return meses === 1 ? 'há 1 mês' : `há ${meses} meses`;
  const anos = Math.floor(meses / 12);
  return anos === 1 ? 'há 1 ano' : `há ${anos} anos`;
}

/** Duração em minutos → texto amigável (ex.: "menos de 1 min", "6 min", "2 h 5 min"). */
export function duracaoMin(minutos: number): string {
  if (minutos <= 0) return 'menos de 1 min';
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
