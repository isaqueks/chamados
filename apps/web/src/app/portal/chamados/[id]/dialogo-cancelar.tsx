'use client';

import { useState } from 'react';
import { StatusChamado } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { acaoTransicionarCliente } from '../actions';

/** Cancelar o chamado com confirmação explícita (specs/04 §1.3; sem otimismo — specs/08 §6). */
export function DialogoCancelar({ chamadoId }: { chamadoId: string }) {
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setAberto(true)}>
        Cancelar chamado
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar este chamado?</DialogTitle>
            <DialogDescription>
              O chamado será encerrado e não poderá ser reaberto. Se precisar, você poderá abrir um
              novo depois.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
              Voltar
            </Button>
            <form action={acaoTransicionarCliente} onSubmit={() => setAberto(false)}>
              <input type="hidden" name="id" value={chamadoId} />
              <input type="hidden" name="novo_status" value={StatusChamado.cancelado} />
              <Button type="submit" variant="destructive">
                Sim, cancelar
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
