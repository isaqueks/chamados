import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderTreeIcon, SquareTerminalIcon, Trash2Icon } from 'lucide-react';
import type { WorktreeDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { EstadoExecucaoBadge } from '@/componentes/badges';
import { Caixa } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { formatarBytes, formatarRelativo } from '@/componentes/apoio/texto';
import { acoesWorktree, ordenarWorktrees, resumoWorktrees } from '@/componentes/historico/logica';

/**
 * Worktrees (specs/forja/06 §4.11, rota `/historico/worktrees`; retenção em
 * 02 §9). Caminho, branch, execução e estado, tamanho, última atividade e a
 * marca **órfã** (sem execução ativa, ou execução terminal com a worktree
 * ainda no disco). Ações: [Abrir no terminal], [Retomar execução], [Limpar…]
 * — limpar remove a worktree e, se você marcar, a branch local (o servidor só
 * apaga a branch se ela já estiver no destino; senão recusa e explica).
 */

const CHAVE = ['worktrees'];

export function TelaWorktrees() {
  const navegar = useNavigate();
  const [limpando, setLimpando] = useState<WorktreeDto | null>(null);
  const [apagarBranch, setApagarBranch] = useState(false);

  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: ({ signal }) => api('worktrees_listar', { sinal: signal }),
  });
  const lista = ordenarWorktrees(consulta.data?.worktrees ?? []);
  const resumo = resumoWorktrees(lista);

  const abrirTerminal = useComando({
    executar: (w: WorktreeDto) =>
      api('terminal_abrir', {
        entrada: { projeto_id: w.projeto_id ?? '', execucao_id: w.execucao_id ?? undefined },
      }),
    invalidar: [['terminal']],
    aoSucesso: (r) => navegar(`/terminal?sessao=${encodeURIComponent(r.sessao_id)}`),
  });
  const limpar = useComando({
    executar: (w: WorktreeDto) =>
      api('worktree_limpar', { entrada: { caminho: w.caminho, apagar_branch: apagarBranch } }),
    invalidar: [CHAVE, ['historico']],
    sucesso: 'Worktree removida',
    aoSucesso: () => setLimpando(null),
  });

  return (
    <Pagina largura="larga">
      <CabecalhoPagina
        voltar={{ href: '/historico', rotulo: 'Histórico' }}
        titulo="Worktrees"
        descricao={
          consulta.data
            ? `${formatarBytes(consulta.data.total_bytes)} ocupados · ${resumo.orfas} ${resumo.orfas === 1 ? 'órfã' : 'órfãs'}${resumo.orfas ? ` (${formatarBytes(resumo.bytesOrfas)})` : ''}`
            : 'Cópias de trabalho de cada execução, fora da sua cópia do repositório.'
        }
      />
      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : lista.length === 0 ? (
        <Vazio icone={FolderTreeIcon} titulo="Nenhuma worktree no disco." />
      ) : (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worktree</TableHead>
                <TableHead>Execução</TableHead>
                <TableHead className="text-right">Tamanho</TableHead>
                <TableHead>Última atividade</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lista.map((w) => {
                const a = acoesWorktree(w);
                return (
                  <TableRow key={w.caminho}>
                    <TableCell className="max-w-96">
                      <span className="block truncate font-mono text-xs" title={w.caminho}>
                        {w.caminho}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {w.branch ?? 'sem branch'}
                        {w.orfa && (
                          <span className="rounded-md border border-amber-300 bg-amber-50 px-1.5 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300">
                            órfã
                          </span>
                        )}
                        {w.prunable && <span>(registro do git sem diretório)</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      {w.execucao_id ? (
                        <div className="flex flex-col gap-1">
                          <Link
                            to={`/execucoes/${w.execucao_id}`}
                            className="text-sm hover:underline"
                          >
                            #{w.numero ?? '?'}
                          </Link>
                          {w.estado_execucao && <EstadoExecucaoBadge estado={w.estado_execucao} />}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">sem execução</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatarBytes(w.tamanho_bytes)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatarRelativo(w.ultima_atividade)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {a.abrirTerminal && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={abrirTerminal.isPending}
                            onClick={() => abrirTerminal.mutate(w)}
                          >
                            <SquareTerminalIcon aria-hidden />
                            Abrir no terminal
                          </Button>
                        )}
                        {a.retomar && w.execucao_id && (
                          <Link
                            to={`/execucoes/${w.execucao_id}`}
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          >
                            Retomar execução
                          </Link>
                        )}
                        {a.limpar && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(w.orfa && 'text-destructive')}
                            onClick={() => {
                              setApagarBranch(false);
                              setLimpando(w);
                            }}
                          >
                            <Trash2Icon aria-hidden />
                            Limpar…
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <DialogoConfirmacao
        aberto={limpando !== null}
        aoMudarAberto={(v) => !v && setLimpando(null)}
        titulo="Remover esta worktree?"
        descricao="Os arquivos da worktree são apagados do disco. Commits já feitos continuam na branch, a menos que você apague a branch também."
        rotuloConfirmar="Remover worktree"
        destrutivo
        pendente={limpar.isPending}
        aoConfirmar={() => limpando && limpar.mutate(limpando)}
      >
        {limpando && (
          <>
            <p className="font-mono text-xs break-all">{limpando.caminho}</p>
            {limpando.branch && (
              <Caixa
                marcada={apagarBranch}
                aoMudar={setApagarBranch}
                rotulo={`Apagar também a branch local ${limpando.branch}`}
                descricao="Só se ela já estiver na branch de destino; senão o servidor recusa e a branch fica."
              />
            )}
            {limpando.estado_execucao === 'mergeado_pendente_chamado' && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Esta execução ainda tem pendências com o Chamados.
              </p>
            )}
          </>
        )}
      </DialogoConfirmacao>
    </Pagina>
  );
}
