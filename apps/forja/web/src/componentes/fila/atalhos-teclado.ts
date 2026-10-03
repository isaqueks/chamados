import { useEffect, useRef } from 'react';

/**
 * Atalhos de teclado das telas (specs/forja/06 §9). Regras:
 * - desligados com o foco em campo de texto (input, textarea, select,
 *   contenteditable) ou no terminal (xterm usa uma textarea oculta, já coberta);
 * - desligados com modificadores (Ctrl/Alt/Meta), para não roubar atalhos do
 *   navegador — `Ctrl+Enter` dos diálogos é tratado no próprio diálogo;
 * - desligados com um diálogo aberto (o diálogo prende o foco e tem os seus);
 * - "Descartar" nunca tem atalho de letra única (06 §9).
 *
 * `teclaDoEvento` é pura (testada); `useAtalhos` só liga o listener.
 */

export interface EventoTeclaMinimo {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  alvo: { tagName?: string; isContentEditable?: boolean; tipo?: string | null } | null;
  dialogoAberto: boolean;
}

const TIPOS_INPUT_NAO_TEXTO = new Set(['checkbox', 'radio', 'button', 'submit', 'range']);

export function focoEmCampoDeTexto(alvo: EventoTeclaMinimo['alvo']): boolean {
  if (!alvo) return false;
  if (alvo.isContentEditable) return true;
  const tag = (alvo.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !TIPOS_INPUT_NAO_TEXTO.has((alvo.tipo ?? 'text').toLowerCase());
  return false;
}

/** Tecla normalizada a tratar, ou null se o atalho não deve disparar. */
export function teclaDoEvento(e: EventoTeclaMinimo): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.dialogoAberto) return null;
  if (focoEmCampoDeTexto(e.alvo)) return null;
  if (e.key === 'Enter' || e.key === '?') return e.key;
  return e.key.length === 1 ? e.key.toLowerCase() : null;
}

export type MapaAtalhos = Partial<Record<string, () => void>>;

function haDialogoAberto(): boolean {
  return (
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]') !== null
  );
}

/** Liga os atalhos enquanto o componente está montado e `ativo`. */
export function useAtalhos(mapa: MapaAtalhos, ativo: boolean = true): void {
  const ref = useRef(mapa);
  ref.current = mapa;
  useEffect(() => {
    if (!ativo) return;
    function aoTeclar(ev: KeyboardEvent): void {
      const alvo = ev.target as HTMLElement | null;
      const tecla = teclaDoEvento({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        alvo: alvo
          ? {
              tagName: alvo.tagName,
              isContentEditable: alvo.isContentEditable,
              tipo: alvo.getAttribute?.('type') ?? null,
            }
          : null,
        dialogoAberto: haDialogoAberto(),
      });
      if (!tecla) return;
      const acao = ref.current[tecla];
      if (!acao) return;
      ev.preventDefault();
      acao();
    }
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [ativo]);
}
