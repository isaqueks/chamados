"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { acaoSalvarGeral, type EstadoConfig } from "./actions"

const INICIAL: EstadoConfig = {}

interface Props {
  diasFechamento: number
  iaResolucaoAuto: boolean
}

export function GeralForm({ diasFechamento, iaResolucaoAuto }: Props) {
  const [estado, acao, pendente] = useActionState(acaoSalvarGeral, INICIAL)

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

      <div className="flex max-w-xs flex-col gap-2">
        <Label htmlFor="dias_fechamento_automatico">
          Dias até o fechamento automático
        </Label>
        <Input
          id="dias_fechamento_automatico"
          name="dias_fechamento_automatico"
          type="number"
          min={1}
          max={365}
          defaultValue={diasFechamento}
          required
        />
        <p className="text-xs text-muted-foreground">
          Um chamado em “resolvido” fecha sozinho após este prazo.
        </p>
      </div>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="ia_resolucao_automatica_habilitada"
          defaultChecked={iaResolucaoAuto}
          className="mt-0.5 size-4 rounded border-input"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            Resolução automática pela IA habilitada
          </span>
          <span className="text-xs text-muted-foreground">
            A IA pode gerar um PR para problemas fáceis. Merge/deploy sempre exige
            aprovação humana (guardrail — o uso real chega no M6+).
          </span>
        </span>
      </label>

      <div>
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar configurações gerais"}
        </Button>
      </div>
    </form>
  )
}
