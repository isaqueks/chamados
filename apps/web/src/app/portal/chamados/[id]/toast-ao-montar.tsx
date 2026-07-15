'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Dispara um toast uma única vez ao montar (ex.: após abrir um chamado e ser
 * redirecionado ao detalhe) e limpa o parâmetro da URL para não repetir no reload.
 */
export function ToastAoMontar({
  texto,
  tipo = 'success',
  limparHref,
}: {
  texto: string;
  tipo?: 'success' | 'info';
  limparHref?: string;
}) {
  const router = useRouter();
  const feito = useRef(false);

  useEffect(() => {
    if (feito.current) return;
    feito.current = true;
    if (tipo === 'info') toast.info(texto);
    else toast.success(texto);
    if (limparHref) router.replace(limparHref, { scroll: false });
  }, [texto, tipo, limparHref, router]);

  return null;
}
