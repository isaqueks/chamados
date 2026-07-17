'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Short-polling da página do chamado (specs/08 §6): re-renderiza os server
 * components (`router.refresh()`) a cada `intervaloMs` para puxar novas
 * mensagens/eventos sem o usuário recarregar. Comportamento:
 *
 * - Pausa quando a aba está OCULTA (economiza servidor/bateria) e dispara um
 *   refresh IMEDIATO ao voltar o foco (o usuário vê o estado fresco na hora).
 * - `router.refresh()` preserva o estado dos client components (editor de
 *   resposta, formulários) — só os dados do servidor são reidratados.
 *
 * Usado no detalhe do chamado do PAINEL e do PORTAL.
 */
export function AtualizacaoPeriodica({ intervaloMs = 60_000 }: { intervaloMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const iniciar = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervaloMs);
    };
    const parar = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const aoMudarVisibilidade = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        iniciar();
      } else {
        parar();
      }
    };

    if (document.visibilityState === 'visible') iniciar();
    document.addEventListener('visibilitychange', aoMudarVisibilidade);
    return () => {
      parar();
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
    };
  }, [router, intervaloMs]);

  return null;
}
