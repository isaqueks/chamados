import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Projeto atual do seletor do cabeçalho (06 §1.2): Fila, Lotes e Fila de merge
 * filtram por ele. Preferência do navegador (conveniência; falhou, nenhum).
 */

const CHAVE = 'forja:projeto-atual';

interface ValorProjetoAtual {
  projetoId: string | null;
  definirProjeto: (id: string | null) => void;
}

const Contexto = createContext<ValorProjetoAtual | null>(null);

function ler(): string | null {
  try {
    return window.localStorage.getItem(CHAVE);
  } catch {
    return null;
  }
}

export function ProjetoAtualProvider({ children }: { children: ReactNode }) {
  const [projetoId, setProjetoId] = useState<string | null>(ler);
  const definirProjeto = useCallback((id: string | null) => {
    setProjetoId(id);
    try {
      if (id) window.localStorage.setItem(CHAVE, id);
      else window.localStorage.removeItem(CHAVE);
    } catch {
      // ignora
    }
  }, []);
  const valor = useMemo(() => ({ projetoId, definirProjeto }), [projetoId, definirProjeto]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useProjetoAtual(): ValorProjetoAtual {
  const v = useContext(Contexto);
  if (!v) throw new Error('useProjetoAtual fora do ProjetoAtualProvider');
  return v;
}
