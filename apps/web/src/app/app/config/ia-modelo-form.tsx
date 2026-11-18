'use client';

import { useActionState, useState } from 'react';
import {
  ESFORCOS_IA,
  MODELOS_IA_SUGERIDOS,
  ROTULO_ESFORCO_IA,
  IA_TIMEOUT_TENANT_MIN_MS,
  LIMITE_IA_MODELO_CHARS,
  formatarMinutos,
  normalizarEsforcoIa,
  type EsforcoIA,
} from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoSalvarConfigModeloIa, type EstadoConfig } from './actions';
import { MODELO_OUTRO } from './ia-modelo-opcoes';

const INICIAL: EstadoConfig = {};

/** Mesmo visual dos selects nativos das forms vizinhas (convite, sistema-alvo). */
const CLASSE_SELECT =
  'flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

interface Props {
  /** Valores do tenant (`null` = padrão da instalação). */
  modelo: string | null;
  esforco: string | null;
  timeoutMs: number | null;
  /** Defaults da instalação (`.env`) — rotulam a opção "Padrão da instalação". */
  padrao: { modelo: string; esforco: EsforcoIA; timeoutMs: number };
  /** Teto do tempo limite (derivado do limiar de execução órfã — D-044). */
  tetoTimeoutMs: number;
}

/**
 * Modelo, esforço de raciocínio e tempo limite da IA do tenant (D-044). Vazio =
 * padrão da instalação. O modelo aceita um ID digitado ("Outro") porque modelos
 * novos surgem antes de entrarem na lista sugerida.
 */
export function IaModeloForm({ modelo, esforco, timeoutMs, padrao, tetoTimeoutMs }: Props) {
  const [estado, acao, pendente] = useActionState(acaoSalvarConfigModeloIa, INICIAL);
  const sugerido = modelo !== null && MODELOS_IA_SUGERIDOS.some((m) => m.id === modelo);
  const [escolha, setEscolha] = useState(modelo === null ? '' : sugerido ? modelo : MODELO_OUTRO);
  const tetoMin = Math.floor(tetoTimeoutMs / 60_000);
  const minMin = IA_TIMEOUT_TENANT_MIN_MS / 60_000;

  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}
      {estado.sucesso && (
        <Alert variant="success">
          <AlertDescription>{estado.sucesso}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ia_modelo">Modelo</Label>
          <select
            id="ia_modelo"
            name="ia_modelo"
            value={escolha}
            onChange={(e) => setEscolha(e.target.value)}
            className={CLASSE_SELECT}
          >
            <option value="">Padrão da instalação ({padrao.modelo})</option>
            {MODELOS_IA_SUGERIDOS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.rotulo} ({m.id})
              </option>
            ))}
            <option value={MODELO_OUTRO}>Outro (digitar o ID)…</option>
          </select>
          {escolha === MODELO_OUTRO && (
            <Input
              id="ia_modelo_outro"
              name="ia_modelo_outro"
              aria-label="ID do modelo"
              defaultValue={sugerido ? '' : (modelo ?? '')}
              maxLength={LIMITE_IA_MODELO_CHARS}
              pattern="[A-Za-z0-9][A-Za-z0-9.\-]*"
              placeholder="ex.: claude-opus-5-5"
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
          <p className="text-xs text-muted-foreground">
            Modelos maiores analisam melhor e custam mais por chamado. Use “Outro” para um modelo
            novo que ainda não está na lista.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ia_esforco">Esforço de raciocínio</Label>
          <select
            id="ia_esforco"
            name="ia_esforco"
            defaultValue={normalizarEsforcoIa(esforco) ?? ''}
            className={CLASSE_SELECT}
          >
            <option value="">Padrão da instalação ({ROTULO_ESFORCO_IA[padrao.esforco]})</option>
            {ESFORCOS_IA.map((n) => (
              <option key={n} value={n}>
                {ROTULO_ESFORCO_IA[n]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Quanto maior, mais a IA pensa antes de responder — análises mais cuidadosas, porém mais
            lentas e caras.
          </p>
        </div>
      </div>

      <div className="flex max-w-xs flex-col gap-2">
        <Label htmlFor="ia_timeout_min">Tempo limite da análise (minutos)</Label>
        <Input
          id="ia_timeout_min"
          name="ia_timeout_min"
          type="number"
          inputMode="numeric"
          min={minMin}
          max={tetoMin}
          step={1}
          defaultValue={timeoutMs !== null ? timeoutMs / 60_000 : ''}
          placeholder={`Padrão da instalação (${formatarMinutos(padrao.timeoutMs)})`}
        />
        <p className="text-xs text-muted-foreground">
          Entre {formatarMinutos(IA_TIMEOUT_TENANT_MIN_MS)} e {formatarMinutos(tetoTimeoutMs)}. Se a
          análise passar disso, ela é interrompida e o chamado vai para a equipe. O teto protege a
          análise de ser tratada como travada. Deixe vazio para usar o padrão.
        </p>
      </div>

      <div>
        <Button type="submit" disabled={pendente}>
          {pendente ? 'Salvando…' : 'Salvar modelo da IA'}
        </Button>
      </div>
    </form>
  );
}
