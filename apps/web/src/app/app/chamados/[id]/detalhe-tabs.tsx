'use client';

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type Aba = 'contexto' | 'timeline' | 'ia';

/**
 * Detalhe do chamado (operador/admin): DUAS colunas no desktop e ABAS no mobile —
 * Contexto / Timeline / Assistente (specs/08 §4.3). O conteúdo é renderizado uma
 * ÚNICA vez (sem duplicar formulários/editor): em `lg+` as três regiões aparecem
 * no grid; no mobile a barra de abas apenas alterna a visibilidade via CSS. Puro
 * layout — nenhuma mudança de lógica ou de ação.
 */
export function ChamadoDetalheTabs({
  contexto,
  timeline,
  ia,
}: {
  contexto: React.ReactNode;
  timeline: React.ReactNode;
  ia: React.ReactNode;
}) {
  const [aba, setAba] = useState<Aba>('timeline');

  return (
    <div className="flex flex-col gap-4">
      {/* Barra de abas — visível só no mobile; no desktop as colunas coexistem. */}
      <Tabs value={aba} onValueChange={(v) => setAba(v as Aba)} className="lg:hidden">
        <TabsList className="w-full">
          <TabsTrigger value="contexto">Contexto</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="ia">Assistente</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_336px]">
        {/* Coluna principal: timeline + compositor. */}
        <div className={cn('min-w-0 lg:order-1 lg:block', aba === 'timeline' ? 'block' : 'hidden')}>
          {timeline}
        </div>

        {/* Coluna lateral: propriedades/detalhes (contexto) + assistente (IA). */}
        <aside
          className={cn(
            'flex-col gap-4 lg:order-2 lg:flex',
            aba === 'timeline' ? 'hidden' : 'flex',
          )}
        >
          <div className={cn('lg:block', aba === 'contexto' ? 'block' : 'hidden')}>{contexto}</div>
          <div className={cn('lg:block', aba === 'ia' ? 'block' : 'hidden')}>{ia}</div>
        </aside>
      </div>
    </div>
  );
}
