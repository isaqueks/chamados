"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { acaoSalvarDominio, type EstadoConfig } from "./actions"

const INICIAL: EstadoConfig = {}

interface Props {
  slug: string
  dominioAtual: string | null
}

export function DominioForm({ slug, dominioAtual }: Props) {
  const [estado, acao, pendente] = useActionState(acaoSalvarDominio, INICIAL)

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

      <div className="flex flex-col gap-2">
        <Label htmlFor="dominio_proprio">Domínio próprio</Label>
        <Input
          id="dominio_proprio"
          name="dominio_proprio"
          defaultValue={dominioAtual ?? ""}
          placeholder="suporte.suaempresa.com"
        />
        <p className="text-xs text-muted-foreground">
          Opcional. Sem domínio próprio, o acesso é por{" "}
          <code className="font-mono">{slug}.chamados.app</code>. Deixe em branco
          para remover. Aponte um CNAME para a plataforma; TLS/ACME é provisionado
          no deploy (fora do escopo de dev).
        </p>
      </div>

      <div>
        <Button type="submit" variant="outline" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar domínio"}
        </Button>
      </div>
    </form>
  )
}
