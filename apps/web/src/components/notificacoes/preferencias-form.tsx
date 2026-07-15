'use client';

import { useState, useTransition } from 'react';
import { Lock } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoDefinirPreferencia } from '@/lib/acoes-preferencias';

export interface PreferenciaItemUi {
  evento: string;
  rotulo: string;
  descricao: string;
  obrigatorio: boolean;
  habilitado: boolean;
}

/**
 * Preferências de notificação por evento (canal e-mail) — specs/06 §7. Eventos
 * OBRIGATÓRIOS ficam travados (ligados) com explicação. Alteração é persistida
 * na hora; em erro, reverte e mostra a mensagem.
 */
export function PreferenciasForm({ itens }: { itens: PreferenciaItemUi[] }) {
  const [estado, setEstado] = useState<Record<string, boolean>>(
    Object.fromEntries(itens.map((i) => [i.evento, i.habilitado])),
  );
  const [erro, setErro] = useState<string | null>(null);
  const [, iniciar] = useTransition();

  function alternar(evento: string, valor: boolean) {
    setErro(null);
    setEstado((s) => ({ ...s, [evento]: valor }));
    iniciar(async () => {
      const r = await acaoDefinirPreferencia(evento, valor);
      if (!r.ok) {
        setErro(r.msg);
        setEstado((s) => ({ ...s, [evento]: !valor })); // reverte
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {erro && (
        <Alert variant="destructive">
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col divide-y rounded-md border">
        {itens.map((i) => (
          <li key={i.evento} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {i.rotulo}
                {i.obrigatorio && <Lock className="size-3.5 text-muted-foreground" />}
              </span>
              <span className="text-xs text-muted-foreground">
                {i.descricao}
                {i.obrigatorio && ' Evento essencial — sempre ativo.'}
              </span>
            </span>
            <Switch
              checked={estado[i.evento]}
              disabled={i.obrigatorio}
              onCheckedChange={(v) => alternar(i.evento, v)}
              aria-label={`Notificações de ${i.rotulo}`}
            />
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        As notificações são enviadas por e-mail. Eventos com cadeado são obrigatórios e não podem
        ser desativados.
      </p>
    </div>
  );
}
