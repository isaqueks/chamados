'use client';

import { useState } from 'react';
import { MENSAGEM_VALOR_BRL, parsearValorBrl, valorParaCampo } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Confirmação de "Marcar resolvido" (D-043, specs/08 §4.3): campo OPCIONAL de
 * custo final (R$, vírgula decimal), pré-preenchido com o valor atual quando
 * houver. Em branco, resolve sem mexer no custo — sem atrito. É o ÚNICO caminho
 * da UI da equipe para `→ resolvido` (o botão de status do painel).
 */
export function DialogoResolver({
  aberto,
  aoMudarAberto,
  custoAtual,
  pendente,
  aoConfirmar,
}: {
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
  custoAtual: number | null;
  pendente: boolean;
  /** Texto digitado ('' = não informar). */
  aoConfirmar: (custo: string) => void;
}) {
  const [custo, setCusto] = useState(() => valorParaCampo(custoAtual));
  const lido = custo.trim() === '' ? null : parsearValorBrl(custo);
  const erro = lido && !lido.ok ? MENSAGEM_VALOR_BRL[lido.motivo] : null;

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        if (pendente) return;
        // Ao fechar sem confirmar, volta ao valor atual (o pai remonta o diálogo
        // com `key` quando o custo gravado muda).
        if (!v) setCusto(valorParaCampo(custoAtual));
        aoMudarAberto(v);
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!erro) aoConfirmar(custo);
          }}
        >
          <DialogHeader>
            <DialogTitle>Marcar como resolvido?</DialogTitle>
            <DialogDescription>
              O cliente é avisado e passa a ter um prazo para aprovar ou contestar a solução.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="custo-final-resolver">Custo final (R$) — opcional</Label>
            <Input
              id="custo-final-resolver"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={custo}
              aria-invalid={erro ? true : undefined}
              aria-describedby="custo-final-resolver-ajuda"
              onChange={(e) => setCusto(e.target.value)}
            />
            <p
              id="custo-final-resolver-ajuda"
              className={erro ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {erro ??
                'Visível ao cliente junto do pedido de aprovação. Deixe em branco para não informar agora.'}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pendente}
              onClick={() => {
                setCusto(valorParaCampo(custoAtual));
                aoMudarAberto(false);
              }}
            >
              Voltar
            </Button>
            <Button type="submit" disabled={pendente || erro !== null}>
              {pendente ? 'Resolvendo…' : 'Marcar resolvido'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
