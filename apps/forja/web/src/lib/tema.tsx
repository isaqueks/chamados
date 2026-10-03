import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Tema claro/escuro/sistema (specs/forja/06 §7): variante `.dark` como no
 * apps/web (`@custom-variant dark`), padrão `prefers-color-scheme`, override
 * manual guardado no navegador. Substitui o `next-themes` do Chamados (a Forja
 * é Vite, sem Next). O `localStorage` é só conveniência: falhou, segue "sistema".
 */

export type Tema = 'claro' | 'escuro' | 'sistema';

const CHAVE = 'forja:tema';

interface ValorTema {
  tema: Tema;
  efetivo: 'claro' | 'escuro';
  definirTema: (tema: Tema) => void;
}

const ContextoTema = createContext<ValorTema | null>(null);

function lerPreferencia(): Tema {
  try {
    const v = window.localStorage.getItem(CHAVE);
    if (v === 'claro' || v === 'escuro' || v === 'sistema') return v;
  } catch {
    // armazenamento bloqueado: segue o sistema
  }
  return 'sistema';
}

function sistemaEscuro(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function TemaProvider({ children }: { children: ReactNode }) {
  const [tema, setTema] = useState<Tema>(lerPreferencia);
  const [escuroSistema, setEscuroSistema] = useState<boolean>(sistemaEscuro);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const aoMudar = (e: MediaQueryListEvent) => setEscuroSistema(e.matches);
    mq.addEventListener('change', aoMudar);
    return () => mq.removeEventListener('change', aoMudar);
  }, []);

  const efetivo: 'claro' | 'escuro' =
    tema === 'sistema' ? (escuroSistema ? 'escuro' : 'claro') : tema;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', efetivo === 'escuro');
    document.documentElement.style.colorScheme = efetivo === 'escuro' ? 'dark' : 'light';
  }, [efetivo]);

  const definirTema = useCallback((novo: Tema) => {
    setTema(novo);
    try {
      window.localStorage.setItem(CHAVE, novo);
    } catch {
      // ignora: preferência vale só nesta aba
    }
  }, []);

  const valor = useMemo(() => ({ tema, efetivo, definirTema }), [tema, efetivo, definirTema]);
  return <ContextoTema.Provider value={valor}>{children}</ContextoTema.Provider>;
}

export function useTema(): ValorTema {
  const v = useContext(ContextoTema);
  if (!v) throw new Error('useTema fora do TemaProvider');
  return v;
}
