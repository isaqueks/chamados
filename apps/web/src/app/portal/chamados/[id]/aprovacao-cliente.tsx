'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, MessageSquareWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { acaoAprovar, acaoContestar, type EstadoChamado } from '../actions';

const INICIAL: EstadoChamado = {};

/**
 * Janela de aprovação do SOLICITANTE (D-042, specs/08 §4.2): o chamado foi
 * resolvido e ele tem até `prazoTexto` para APROVAR (encerra) ou CONTESTAR
 * (motivo obrigatório; volta para atendimento). Sem resposta, vale como
 * aprovação. Substitui o "Reabrir" simples do `resolvido`; sem otimismo — o
 * estado só muda com a resposta do servidor (specs/08 §6).
 */
export function AprovacaoCliente({
  chamadoId,
  prazoTexto,
  custoFinalTexto,
}: {
  chamadoId: string;
  /** Prazo já formatado (pt-BR); `null` quando o chamado não tem prazo gravado. */
  prazoTexto: string | null;
  /**
   * D-043: custo final já formatado em BRL (`null` = não informado) — o cliente
   * aprova sabendo o valor.
   */
  custoFinalTexto?: string | null;
}) {
  const [estadoAprovar, aprovar, aprovando] = useActionState(acaoAprovar, INICIAL);
  const [estadoContestar, contestar, contestando] = useActionState(acaoContestar, INICIAL);
  const [contestarAberto, setContestarAberto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const tratado = useRef<EstadoChamado | null>(null);

  useEffect(() => {
    for (const estado of [estadoAprovar, estadoContestar]) {
      if (estado === INICIAL || tratado.current === estado) continue;
      if (estado.sucesso) {
        tratado.current = estado;
        // Sem limpar o formulário aqui: aprovado ou contestado, o chamado sai de
        // `resolvido` e a revalidação da página desmonta este bloco.
        toast.success(estado.sucesso);
      }
    }
  }, [estadoAprovar, estadoContestar]);

  const pendente = aprovando || contestando;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-start gap-3">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Este chamado foi resolvido
          </p>
          <p className="text-sm text-muted-foreground">
            {prazoTexto ? (
              <>
                Você tem até <span className="font-medium text-foreground">{prazoTexto}</span> para
                aprovar ou contestar a solução; sem resposta, ele será considerado aprovado.
              </>
            ) : (
              'Aprove ou conteste a solução; sem resposta no prazo, ele será considerado aprovado.'
            )}
          </p>
          {custoFinalTexto && (
            <p className="text-sm text-muted-foreground">
              Custo final:{' '}
              <span className="font-medium text-foreground tabular-nums">{custoFinalTexto}</span>
            </p>
          )}
        </div>
      </div>

      {estadoAprovar.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estadoAprovar.erro}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pendente}
          onClick={() => setContestarAberto(true)}
        >
          <MessageSquareWarning />
          Contestar
        </Button>
        <form action={aprovar}>
          <input type="hidden" name="id" value={chamadoId} />
          <Button type="submit" size="sm" disabled={pendente}>
            <CircleCheck />
            {aprovando ? 'Aprovando…' : 'Aprovar'}
          </Button>
        </form>
      </div>

      <Dialog open={contestarAberto} onOpenChange={(v) => !contestando && setContestarAberto(v)}>
        <DialogContent>
          <form action={contestar} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Contestar a solução</DialogTitle>
              <DialogDescription>
                Conte o que ainda não está resolvido. O chamado volta para atendimento e a sua
                mensagem aparece na conversa.
              </DialogDescription>
            </DialogHeader>

            <input type="hidden" name="id" value={chamadoId} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="motivo-contestacao">Motivo</Label>
              <Textarea
                id="motivo-contestacao"
                name="motivo"
                required
                maxLength={5000}
                rows={4}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ex.: o erro continua aparecendo ao emitir a nota."
              />
            </div>

            {estadoContestar.erro && (
              <Alert variant="destructive">
                <AlertDescription>{estadoContestar.erro}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={contestando}
                onClick={() => setContestarAberto(false)}
              >
                Voltar
              </Button>
              <Button type="submit" disabled={contestando || motivo.trim().length === 0}>
                {contestando ? 'Enviando…' : 'Enviar contestação'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
