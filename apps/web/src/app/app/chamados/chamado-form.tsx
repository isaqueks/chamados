"use client"

import { useActionState, useEffect, useRef } from "react"
import { Natureza, Prioridade } from "@chamados/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ROTULO_NATUREZA, ROTULO_PRIORIDADE } from "@/lib/rotulos"
import { acaoCriarChamado, type EstadoChamado } from "./actions"

const INICIAL: EstadoChamado = {}

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function ChamadoForm() {
  const [estado, acao, pendente] = useActionState(acaoCriarChamado, INICIAL)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (estado.sucesso) formRef.current?.reset()
  }, [estado.sucesso])

  return (
    <form ref={formRef} action={acao} className="flex flex-col gap-4">
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
        <Label htmlFor="titulo">Título</Label>
        <Input
          id="titulo"
          name="titulo"
          placeholder="Resuma o problema ou pedido"
          required
          minLength={3}
          maxLength={160}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="natureza">Natureza</Label>
          <select id="natureza" name="natureza" className={SELECT_CLS} defaultValue={Natureza.problema}>
            <option value={Natureza.problema}>{ROTULO_NATUREZA[Natureza.problema]}</option>
            <option value={Natureza.alteracao}>{ROTULO_NATUREZA[Natureza.alteracao]}</option>
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="prioridade">Prioridade</Label>
          <select id="prioridade" name="prioridade" className={SELECT_CLS} defaultValue={Prioridade.media}>
            {Object.values(Prioridade).map((p) => (
              <option key={p} value={p}>
                {ROTULO_PRIORIDADE[p]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="descricao">Descrição</Label>
        <textarea
          id="descricao"
          name="descricao"
          required
          rows={4}
          placeholder="Descreva com detalhes. (Rich text e anexos chegam no M4.)"
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div>
        <Button type="submit" disabled={pendente} size="lg">
          {pendente ? "Abrindo…" : "Abrir chamado"}
        </Button>
      </div>
    </form>
  )
}
