import type { SessaoTerminalDto } from '@comum/dto';

/**
 * Regras puras do Terminal (specs/forja/06 §4.7; protocolo do WebSocket em
 * 01 §8.1/§11 — implementado em `lib/terminal.ts`): ordem das abas, atalho
 * `Ctrl+Shift+←/→`, o texto de saída e o tema do xterm derivado dos tokens
 * (06 §7: fundo `--card` no escuro, cursor `--primary`).
 */

/** Abas: vivas primeiro, depois encerradas; dentro de cada grupo, pela abertura. */
export function ordenarSessoes(sessoes: SessaoTerminalDto[]): SessaoTerminalDto[] {
  return [...sessoes].sort((a, b) => {
    if (a.viva !== b.viva) return a.viva ? -1 : 1;
    return a.aberta_em.localeCompare(b.aberta_em);
  });
}

/** Índice da aba vizinha com volta (`-1` = esquerda). */
export function indiceVizinho(atual: number, total: number, direcao: -1 | 1): number {
  if (total <= 0) return -1;
  const base = atual < 0 || atual >= total ? 0 : atual;
  return (base + direcao + total) % total;
}

/** `Ctrl+Shift+←/→` troca de aba (06 §9). Devolve a direção, ou `null`. */
export function direcaoAtalho(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}): -1 | 1 | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.key === 'ArrowLeft') return -1;
  if (e.key === 'ArrowRight') return 1;
  return null;
}

/** "saiu com código 0" / "encerrado por SIGHUP". */
export function descreverSaida(c: { codigo: number | null; sinal: string | null }): string {
  if (c.sinal) return `encerrado por ${c.sinal}`;
  if (c.codigo !== null) return `saiu com código ${c.codigo}`;
  return 'encerrado';
}

export interface TemaTerminal {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

/** `[r,g,b,a]` (0–255) → `#rrggbb` (a opacidade da seleção é aplicada à parte). */
export function rgbParaHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Tema do xterm a partir dos tokens. `cor(token)` resolve o token CSS para
 * `#rrggbb` (no navegador, pintando num canvas — o xterm não entende `oklch`).
 * Claro: fundo `--card`; escuro: fundo `--card` também (06 §7), texto
 * `--card-foreground`, cursor `--primary`.
 */
export function temaTerminal(cor: (token: string) => string | null): TemaTerminal {
  const fundo = cor('--card') ?? '#ffffff';
  const texto = cor('--card-foreground') ?? '#111111';
  const primaria = cor('--primary') ?? texto;
  return {
    background: fundo,
    foreground: texto,
    cursor: primaria,
    cursorAccent: fundo,
    selectionBackground: `${primaria}55`,
  };
}
