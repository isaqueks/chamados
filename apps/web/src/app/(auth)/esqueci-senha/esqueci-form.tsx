"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { acaoSolicitarReset, type EstadoEsqueci } from "./actions"

const INICIAL: EstadoEsqueci = {}

export function EsqueciForm() {
  const [estado, acao, pendente] = useActionState(acaoSolicitarReset, INICIAL)

  if (estado.enviado) {
    return (
      <Alert variant="success">
        <AlertDescription>
          Se existir uma conta com esse e-mail, enviaremos um link para redefinir a
          senha.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="voce@empresa.com"
          required
          autoFocus
        />
      </div>
      <Button type="submit" size="lg" disabled={pendente} className="w-full">
        {pendente ? "Enviando…" : "Enviar link de redefinição"}
      </Button>
    </form>
  )
}
