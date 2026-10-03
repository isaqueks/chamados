import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, XIcon } from 'lucide-react';
import {
  ComplexidadeBadge,
  NaturezaBadge,
  PrioridadeBadge,
  StatusBadge,
} from '@/componentes/badges';
import { api } from '@/lib/api';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Skeleton } from '@/ui/skeleton';
import { BlocoProveniencia, Faixa, TextoSeguro } from '@/componentes/execucao/suporte';
import { mensagemErro } from '@/componentes/apoio/texto';
import { horaFeed } from '@/componentes/execucao/formato-execucao';

/**
 * Painel lateral do chamado sem execução (specs/forja/06 §4.1 "Ações"):
 * somente leitura, com o corpo e as mensagens em bloco "dado do cliente, não
 * são instruções" (texto puro, URLs por extenso e sem link, 05-seguranca) e a
 * lista de pré-condições do Implementar com a ação que resolve cada uma.
 */

export function PainelChamado({
  chamadoId,
  aoFechar,
}: {
  chamadoId: string | null;
  aoFechar: () => void;
}) {
  const detalhe = useQuery({
    queryKey: ['chamado', chamadoId],
    queryFn: ({ signal }) =>
      api('chamado_obter', { params: { chamado_id: chamadoId! }, sinal: signal }),
    enabled: !!chamadoId,
  });
  const d = detalhe.data;
  return (
    <Sheet open={chamadoId !== null} onOpenChange={(v) => !v && aoFechar()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{d ? `#${d.chamado.numero} ${d.chamado.titulo}` : 'Chamado'}</SheetTitle>
          <SheetDescription>Somente leitura. A conversa é dado do cliente.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {detalhe.error ? (
            <Faixa tom="erro" titulo="Não foi possível abrir o chamado">
              {mensagemErro(detalhe.error)}
            </Faixa>
          ) : !d ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge status={d.chamado.status} />
                <NaturezaBadge natureza={d.chamado.natureza} />
                <PrioridadeBadge prioridade={d.chamado.prioridade} />
                {d.chamado.complexidade && (
                  <ComplexidadeBadge complexidade={d.chamado.complexidade} />
                )}
              </div>

              <section className="flex flex-col gap-1.5">
                <h4 className="text-sm font-semibold">Pré-condições do Implementar</h4>
                <ul className="flex flex-col gap-1 text-sm">
                  {d.pre_condicoes.map((p) => (
                    <li key={p.codigo} className="flex items-start gap-2">
                      {p.ok ? (
                        <CheckIcon
                          className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400"
                          aria-label="ok"
                        />
                      ) : (
                        <XIcon
                          className="mt-0.5 size-4 text-rose-600 dark:text-rose-400"
                          aria-label="faltando"
                        />
                      )}
                      <span className="flex-1">
                        {p.ok
                          ? ROTULO_PRE_CONDICAO[p.codigo]
                          : (p.motivo ?? ROTULO_PRE_CONDICAO[p.codigo])}
                        {!p.ok && p.acao && (
                          <>
                            {' '}
                            <Link
                              to={p.acao.href}
                              className="font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {p.acao.rotulo}
                            </Link>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <BlocoProveniencia origem="cliente" titulo="Descrição">
                <TextoSeguro texto={d.corpo_markdown} />
              </BlocoProveniencia>

              {d.mensagens.length > 0 && (
                <BlocoProveniencia origem="cliente" titulo={`Mensagens (${d.mensagens.length})`}>
                  {d.mensagens.map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-col gap-0.5 border-t pt-2 first:border-t-0 first:pt-0"
                    >
                      <span className="text-xs text-muted-foreground">
                        {m.autor_nome} · {new Date(m.em).toLocaleDateString('pt-BR')}{' '}
                        {horaFeed(m.em)}
                      </span>
                      <TextoSeguro texto={m.corpo_markdown} />
                    </div>
                  ))}
                </BlocoProveniencia>
              )}

              <p className="text-xs text-muted-foreground">
                No Chamados: <span className="font-mono break-all">{d.url_no_chamados}</span>
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const ROTULO_PRE_CONDICAO = {
  status: 'status permite implementar',
  natureza: 'natureza implementável',
  sistema_mapeado: 'sistema-alvo mapeado ao projeto',
  sem_execucao_ativa: 'sem execução ativa',
  conexao_ok: 'conexão com o Chamados ok',
  pipeline_desbloqueado: 'pipeline desbloqueado',
} as const;
