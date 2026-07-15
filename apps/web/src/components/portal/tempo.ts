/** Tempo relativo amigável em pt-BR ("há 5 minutos", "há 2 horas", "há 3 dias"). */
export function tempoRelativo(data: Date | string): string {
  const ms = Date.now() - new Date(data).getTime();
  const seg = Math.round(ms / 1000);
  if (seg < 45) return 'agora mesmo';

  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const min = Math.round(seg / 60);
  if (min < 60) return rtf.format(-min, 'minute');
  const horas = Math.round(min / 60);
  if (horas < 24) return rtf.format(-horas, 'hour');
  const dias = Math.round(horas / 24);
  if (dias < 30) return rtf.format(-dias, 'day');
  return new Date(data).toLocaleDateString('pt-BR');
}

/** Data/hora absoluta em pt-BR (para `title`/tooltip). */
export function dataHoraAbsoluta(data: Date | string): string {
  return new Date(data).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
}
