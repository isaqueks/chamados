import type { ReactNode } from 'react';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Campo } from './campos';

/**
 * Controles de formulário com erro/aviso por caminho do campo (Configurações,
 * FJ-030 §2). Todos recebem o caminho (`limites.timeout_min.planejar`) e leem
 * erro/aviso do mapa da tela, para que a mensagem fique sempre embaixo do
 * controle que a causou.
 */

export interface MensagensCampo {
  erros: Record<string, string>;
  avisos: Record<string, string>;
}

export function CampoTexto({
  caminho,
  rotulo,
  valor,
  aoMudar,
  msgs,
  ajuda,
  placeholder,
  mono,
  somenteLeitura,
  tipo = 'text',
}: {
  caminho: string;
  rotulo: ReactNode;
  valor: string;
  aoMudar?: (v: string) => void;
  msgs: MensagensCampo;
  ajuda?: ReactNode;
  placeholder?: string;
  mono?: boolean;
  somenteLeitura?: boolean;
  tipo?: 'text' | 'password' | 'email' | 'url';
}) {
  const erro = msgs.erros[caminho];
  return (
    <Campo rotulo={rotulo} erro={erro} aviso={msgs.avisos[caminho]} ajuda={ajuda}>
      {(id) => (
        <Input
          id={id}
          type={tipo}
          value={valor}
          placeholder={placeholder}
          readOnly={somenteLeitura}
          onChange={(e) => aoMudar?.(e.target.value)}
          aria-invalid={erro ? true : undefined}
          className={mono ? 'font-mono text-xs' : undefined}
          spellCheck={false}
        />
      )}
    </Campo>
  );
}

/**
 * Número. Campo vazio vira `NaN` no estado — o esquema recusa com "informe um
 * número" em vez de salvar zero sem querer. `escala` mostra frações como
 * porcentagem (freio de cota 0,8 → 80).
 */
export function CampoNumero({
  caminho,
  rotulo,
  valor,
  aoMudar,
  msgs,
  ajuda,
  escala = 1,
  passo = 1,
  sufixo,
}: {
  caminho: string;
  rotulo: ReactNode;
  valor: number;
  aoMudar: (v: number) => void;
  msgs: MensagensCampo;
  ajuda?: ReactNode;
  escala?: number;
  passo?: number;
  sufixo?: string;
}) {
  const erro = msgs.erros[caminho];
  const exibido = Number.isFinite(valor) ? Math.round(valor * escala * 1000) / 1000 : '';
  return (
    <Campo rotulo={rotulo} erro={erro} aviso={msgs.avisos[caminho]} ajuda={ajuda}>
      {(id) => (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            step={passo}
            value={exibido}
            onChange={(e) => {
              const t = e.target.value;
              aoMudar(t === '' ? Number.NaN : Number(t) / escala);
            }}
            aria-invalid={erro ? true : undefined}
            className="w-28 tabular-nums"
          />
          {sufixo && <span className="text-xs text-muted-foreground">{sufixo}</span>}
        </div>
      )}
    </Campo>
  );
}

/** Interruptor com rótulo e a consequência escrita ao lado (06 §4.8). */
export function CampoInterruptor({
  rotulo,
  descricao,
  marcado,
  aoMudar,
  desabilitado,
  aviso,
}: {
  rotulo: ReactNode;
  descricao?: ReactNode;
  marcado: boolean;
  aoMudar: (v: boolean) => void;
  desabilitado?: boolean;
  aviso?: string | null;
}) {
  return (
    <label className="flex items-start gap-3">
      <Switch
        checked={marcado}
        onCheckedChange={(v) => aoMudar(v)}
        disabled={desabilitado}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{rotulo}</span>
        {descricao && <span className="text-xs text-muted-foreground">{descricao}</span>}
        {aviso && <span className="text-xs text-amber-700 dark:text-amber-400">{aviso}</span>}
      </span>
    </label>
  );
}
