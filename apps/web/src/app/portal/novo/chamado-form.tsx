'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import {
  CampoDescricao,
  CampoNatureza,
  CampoPrioridade,
  CampoSistema,
  CampoTitulo,
  useCamposChamado,
  type OpcaoSistema,
} from '@/components/chamado/campos-chamado';
import { acaoCriarChamado, type EstadoChamado } from '../chamados/actions';

const INICIAL: EstadoChamado = {};

export function ChamadoNovoForm({
  sistemas,
  tituloInicial = '',
}: {
  sistemas: OpcaoSistema[];
  tituloInicial?: string;
}) {
  const [estado, acao, pendente] = useActionState(acaoCriarChamado, INICIAL);
  const { titulo, setTitulo, aoMudarDescricao, camposValidos } = useCamposChamado(tituloInicial);

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      <CampoSistema sistemas={sistemas} />

      <CampoTitulo
        value={titulo}
        onChange={setTitulo}
        placeholder="Ex.: Não consigo emitir a segunda via do boleto"
      />

      <CampoDescricao
        onChange={aoMudarDescricao}
        placeholder="Descreva com detalhes. Você pode colar ou arrastar imagens (prints)."
        dica="Dica: colar um print ajuda muito a entender o problema."
      />

      <details className="group rounded-lg border border-input">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          Opções avançadas
          <span className="text-xs transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-input p-3">
          <CampoNatureza
            rotulo="Tipo do chamado (opcional)"
            rotuloAutomatico="Automático — nossa assistente identifica"
          />
          <CampoPrioridade
            rotulo="Prioridade (opcional)"
            ajuda="Não tem certeza? Deixe como está — nossa assistente identifica o tipo e ajusta a prioridade na triagem."
          />
        </div>
      </details>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Link href="/portal" className={cn(buttonVariants({ variant: 'ghost' }))}>
          Cancelar
        </Link>
        <Button type="submit" size="lg" disabled={pendente || !camposValidos}>
          {pendente ? 'Abrindo…' : 'Abrir chamado'}
        </Button>
      </div>
    </form>
  );
}
