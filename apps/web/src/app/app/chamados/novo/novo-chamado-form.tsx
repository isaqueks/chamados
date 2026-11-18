'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  CampoDescricao,
  CampoEstimativaCusto,
  CampoNatureza,
  CampoPrioridade,
  CampoSistema,
  CampoTitulo,
  useCamposChamado,
  type OpcaoSistema,
} from '@/components/chamado/campos-chamado';
import type { OpcaoSolicitante } from '@/lib/form-chamado';
import { acaoCriarChamado, type EstadoCriarChamado } from '../actions';
import { SeletorSolicitante } from './seletor-solicitante';

const INICIAL: EstadoCriarChamado = {};

/**
 * Formulário do "Novo chamado" do painel (D-040): mesmos campos do portal
 * (componentes compartilhados) + solicitante obrigatório; natureza e prioridade
 * ficam à vista — a equipe pode escolher (default "Automático" / Média). No
 * sucesso, toast e navegação ao detalhe do chamado criado.
 */
export function NovoChamadoForm({
  sistemas,
  clientes,
}: {
  sistemas: OpcaoSistema[];
  clientes: OpcaoSolicitante[];
}) {
  const router = useRouter();
  const [estado, acao, pendente] = useActionState(acaoCriarChamado, INICIAL);
  const { titulo, setTitulo, aoMudarDescricao, camposValidos } = useCamposChamado();
  const [solicitante, setSolicitante] = useState<OpcaoSolicitante | null>(null);
  const navegado = useRef<string | null>(null);

  const criado = estado.criado;
  useEffect(() => {
    if (!criado || navegado.current === criado.id) return;
    navegado.current = criado.id;
    toast.success(
      solicitante
        ? `Chamado #${criado.numero} aberto em nome de ${solicitante.label}.`
        : `Chamado #${criado.numero} aberto.`,
    );
    router.push(`/app/chamados/${criado.id}`);
  }, [criado, solicitante, router]);

  const ocupado = pendente || Boolean(criado);
  const podeEnviar = camposValidos && solicitante !== null;

  return (
    <form action={acao} className="flex flex-col gap-5" aria-busy={ocupado}>
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      <SeletorSolicitante opcoes={clientes} valor={solicitante} aoMudar={setSolicitante} />

      <CampoSistema sistemas={sistemas} />

      <CampoTitulo
        value={titulo}
        onChange={setTitulo}
        placeholder="Ex.: Cliente não consegue emitir a segunda via do boleto"
      />

      <CampoDescricao
        onChange={aoMudarDescricao}
        placeholder="Descreva o que o cliente relatou. Você pode colar ou arrastar imagens (prints)."
        dica="A descrição é pública: o cliente a vê no portal. Detalhes internos vão em nota interna, depois de abrir."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <CampoNatureza
          rotulo="Natureza"
          rotuloAutomatico="Automático — a IA classifica na triagem"
        />
        <CampoPrioridade rotulo="Prioridade" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <CampoEstimativaCusto
          rotulo="Estimativa de custo (opcional)"
          ajuda="Visível ao cliente. Pode ser definida ou alterada depois, no painel do chamado."
        />
      </div>

      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
        <Link href="/app/chamados" className={buttonVariants({ variant: 'ghost' })}>
          Cancelar
        </Link>
        <Button type="submit" size="lg" disabled={ocupado || !podeEnviar}>
          {pendente ? 'Abrindo…' : criado ? 'Abrindo o chamado…' : 'Abrir chamado'}
        </Button>
      </div>
    </form>
  );
}
