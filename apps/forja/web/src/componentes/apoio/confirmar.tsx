import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';

/**
 * Diálogo de confirmação das ações irreversíveis (specs/forja/06 §6 item 5 e
 * §9): mostra os dados CONCRETOS do que será feito, o foco inicial fica em
 * Cancelar, `Ctrl+Enter` confirma e `Esc` cancela. Sem feedback otimista: o
 * botão fica "aguardando" até o servidor gravar, e o diálogo só fecha depois.
 *
 * `digitar` exige que o usuário digite um texto (ex.: o número do chamado em
 * "Aprovar mesmo assim…" de 06 §4.4 e em "Apagar dados deste chamado…" de
 * 05 §11) — a fricção é proposital para o que não tem volta.
 */
export function DialogoConfirmacao({
  aberto,
  aoMudarAberto,
  titulo,
  descricao,
  children,
  rotuloConfirmar,
  destrutivo = false,
  digitar,
  bloqueado = false,
  pendente = false,
  aoConfirmar,
  largo = false,
}: {
  aberto: boolean;
  aoMudarAberto: (aberto: boolean) => void;
  titulo: ReactNode;
  descricao?: ReactNode;
  children?: ReactNode;
  rotuloConfirmar: string;
  destrutivo?: boolean;
  digitar?: { esperado: string; rotulo: string };
  /** Pré-condição do conteúdo não satisfeita (ex.: nenhum item marcado). */
  bloqueado?: boolean;
  pendente?: boolean;
  aoConfirmar: () => void;
  largo?: boolean;
}) {
  const cancelarRef = useRef<HTMLButtonElement>(null);
  const [digitado, setDigitado] = useState('');
  const idDigitar = useId();

  useEffect(() => {
    if (!aberto) setDigitado('');
  }, [aberto]);

  const digitacaoOk = !digitar || digitado.trim() === digitar.esperado;
  const podeConfirmar = digitacaoOk && !bloqueado && !pendente;

  return (
    <Dialog open={aberto} onOpenChange={(v) => !pendente && aoMudarAberto(v)}>
      <DialogContent
        className={largo ? 'sm:max-w-2xl' : undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelarRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && podeConfirmar) {
            e.preventDefault();
            aoConfirmar();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          {descricao && <DialogDescription>{descricao}</DialogDescription>}
        </DialogHeader>
        {children && (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-sm">{children}</div>
        )}
        {digitar && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={idDigitar}>{digitar.rotulo}</Label>
            <Input
              id={idDigitar}
              value={digitado}
              onChange={(e) => setDigitado(e.target.value)}
              autoComplete="off"
              inputMode="numeric"
            />
          </div>
        )}
        <DialogFooter>
          <Button
            ref={cancelarRef}
            variant="outline"
            onClick={() => aoMudarAberto(false)}
            disabled={pendente}
          >
            Cancelar
          </Button>
          <Button
            variant={destrutivo ? 'destructive' : 'default'}
            onClick={aoConfirmar}
            disabled={!podeConfirmar}
            title="Ctrl+Enter"
          >
            {pendente && <Loader2Icon className="animate-spin" aria-hidden />}
            {rotuloConfirmar}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
