"use client"

import { useActionState, useEffect, useRef } from "react"
import { VisibilidadeMensagem } from "@chamados/shared"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { acaoResponder, type EstadoChamado } from "../actions"

const INICIAL: EstadoChamado = {}

/**
 * Formulário de resposta na timeline (specs/04 §6). Cliente só publica mensagem
 * pública; operador/admin escolhem Pública/Interna com DEFAULT Interna (specs/08).
 * O editor rico (TipTap) é M5 — aqui é textarea, mas o pipeline server-side é o
 * real (sanitização/anexos). Upload de anexos por `multipart` (progressive
 * enhancement do server action).
 */
export function RespostaForm({ chamadoId, podeInterna }: { chamadoId: string; podeInterna: boolean }) {
  const [estado, acao, pendente] = useActionState(acaoResponder, INICIAL)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (estado.sucesso) formRef.current?.reset()
  }, [estado.sucesso])

  const SELECT_CLS =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <form ref={formRef} action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="chamado_id" value={chamadoId} />

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

      {podeInterna && (
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor="visibilidade">Visibilidade</Label>
          <select
            id="visibilidade"
            name="visibilidade"
            className={SELECT_CLS}
            defaultValue={VisibilidadeMensagem.interna}
          >
            <option value={VisibilidadeMensagem.interna}>Nota interna (equipe)</option>
            <option value={VisibilidadeMensagem.publica}>Pública (visível ao cliente)</option>
          </select>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="corpo">Mensagem</Label>
        <textarea
          id="corpo"
          name="corpo"
          required
          rows={4}
          placeholder={podeInterna ? "Responda ou registre uma nota interna…" : "Escreva sua mensagem…"}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="anexos">Anexos (opcional)</Label>
        <input
          id="anexos"
          name="anexos"
          type="file"
          multiple
          className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Imagens, PDF, texto/CSV, docx/xlsx ou zip — até 25 MB cada.
        </p>
      </div>

      <div>
        <Button type="submit" disabled={pendente}>
          {pendente ? "Enviando…" : "Enviar"}
        </Button>
      </div>
    </form>
  )
}
