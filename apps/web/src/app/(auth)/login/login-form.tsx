"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { acaoLogin, type EstadoLogin } from "./actions"

const INICIAL: EstadoLogin = {}

export function LoginForm() {
  const [estado, acao, pendente] = useActionState(acaoLogin, INICIAL)

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

      <div className="flex flex-col gap-2">
        <Label htmlFor="senha">Senha</Label>
        <Input
          id="senha"
          name="senha"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <Button type="submit" size="lg" disabled={pendente} className="mt-1 w-full">
        {pendente ? "Entrando…" : "Entrar"}
      </Button>
    </form>
  )
}
