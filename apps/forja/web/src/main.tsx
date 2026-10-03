import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './estilos/globals.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { ErroApiForja } from '@/lib/api';
import { TemaProvider } from '@/lib/tema';
import { Toaster } from '@/ui/sonner';
import { TooltipProvider } from '@/ui/tooltip';
import { roteador } from './rotas';

/**
 * Entrada da SPA da Forja (specs/forja/01 §4.1, 06). Fontes self-hosted (sem
 * CDN: a CSP bloquearia), TanStack Query para os GETs da API local e o
 * roteador com uma rota por tela de 06 §2.
 */

const clienteQuery = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx (inclusive 501 "não implementado" e 401) não melhora tentando de novo.
      retry: (falhas, erro) =>
        !(erro instanceof ErroApiForja && erro.status >= 400 && erro.status < 600) && falhas < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('#raiz não encontrado');

createRoot(raiz).render(
  <StrictMode>
    <TemaProvider>
      <QueryClientProvider client={clienteQuery}>
        <TooltipProvider>
          <RouterProvider router={roteador} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </TemaProvider>
  </StrictMode>,
);
