import { Link } from 'react-router';
import type { LinhaFilaDto } from '@comum/dto';
import {
  BadgeUi,
  ComplexidadeBadge,
  EstadoExecucaoBadge,
  NaturezaBadge,
  PrioridadeBadge,
  SinalFila,
  StatusBadge,
} from '@/componentes/badges';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { CaixaMarcacao } from '@/componentes/execucao/suporte';
import { alternarTodos, celulaForja, linhaEsmaecida, selecionavel } from './logica-fila';

/**
 * Tabela da Fila (specs/forja/06 §4.1, wireframe): seleção, #, chamado (com a
 * complexidade, que sempre aparece), status, natureza, prioridade, sinais e a
 * coluna "Forja" — Implementar, o motivo de indisponibilidade (tooltip), ou o
 * estado do pipeline com [Abrir]/[Aprovar]. Estados terminais ficam
 * esmaecidos. Os sinais chegam de forma preguiçosa: até lá, skeleton.
 *
 * Teclado (06 §9): a linha do cursor (`j`/`k`) fica destacada e é a que `x`
 * seleciona e `Enter` abre — a tela liga as teclas.
 */

function Sinais({ linha }: { linha: LinhaFilaDto }) {
  const s = linha.sinais;
  if (!s.carregado) return <Skeleton className="h-5 w-16" aria-label="carregando sinais" />;
  return (
    <div className="flex flex-wrap gap-1">
      {(s.tem_spec_ia || s.tem_diagnostico_ia) && <SinalFila sinal="spec" />}
      {s.tem_pr_ia && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            }
          >
            <SinalFila sinal="pr_ia" />
          </TooltipTrigger>
          <TooltipContent>
            branch da IA: <span className="font-mono">{s.branch_ia ?? '—'}</span>. No MVP, só dá
            para ignorar ao implementar.
          </TooltipContent>
        </Tooltip>
      )}
      {s.ia_silenciada === false && <SinalFila sinal="ia_ativa" />}
      {s.ia_silenciada === true && <SinalFila sinal="ia_silenciada" />}
      {s.cliente_respondeu && <SinalFila sinal="cliente_respondeu" />}
    </div>
  );
}

function CelulaForja({
  linha,
  aoImplementar,
  implementando,
}: {
  linha: LinhaFilaDto;
  aoImplementar: (l: LinhaFilaDto) => void;
  implementando: boolean;
}) {
  const c = celulaForja(linha);
  const ex = linha.execucao;
  switch (c.tipo) {
    case 'implementar':
      return (
        <Button
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            aoImplementar(linha);
          }}
          disabled={implementando}
        >
          Implementar
        </Button>
      );
    case 'indisponivel':
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="inline-flex flex-col items-start gap-0.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            <Button
              size="sm"
              variant="outline"
              aria-disabled
              tabIndex={-1}
              className="pointer-events-none opacity-60"
            >
              Implementar ✗
            </Button>
            <span className="text-[0.7rem] text-muted-foreground">indisponível</span>
          </TooltipTrigger>
          <TooltipContent className="flex-col items-start">
            <span className="font-medium">Falta:</span>
            <ul className="list-disc pl-4">
              {c.motivos.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      );
    case 'triagem':
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            }
          >
            — (triagem)
          </TooltipTrigger>
          <TooltipContent>
            A triagem do servidor pode estar rodando; aguarde “em atendimento”.
          </TooltipContent>
        </Tooltip>
      );
    case 'terminal':
      return <span className="text-sm text-muted-foreground">—</span>;
    case 'em_voo':
    case 'aprovar':
      return (
        <div className="flex flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-1">
            {ex && <EstadoExecucaoBadge estado={ex.estado} />}
            {ex?.altera_ui && (
              <BadgeUi
                telas={0}
                semPrintsMotivo={
                  ex.evidencia_visual === 'parcial' ||
                  ex.evidencia_visual === 'sem_evidencia_visual'
                    ? 'prints incompletos'
                    : null
                }
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {ex?.progresso && (
              <span className="text-xs text-muted-foreground">
                {ex.progresso.feitos}/{ex.progresso.total}
              </span>
            )}
            <Button
              size="xs"
              variant={c.tipo === 'aprovar' ? 'default' : 'outline'}
              render={<Link to={c.href} onClick={(e) => e.stopPropagation()} />}
            >
              {c.tipo === 'aprovar' ? 'Aprovar' : 'Abrir'}
            </Button>
          </div>
        </div>
      );
  }
}

export function TabelaFila({
  linhas,
  selecao,
  aoMudarSelecao,
  cursor,
  aoMudarCursor,
  aoAbrir,
  aoImplementar,
  implementandoId,
  desabilitada,
}: {
  linhas: LinhaFilaDto[];
  selecao: ReadonlySet<string>;
  aoMudarSelecao: (s: Set<string>) => void;
  cursor: number;
  aoMudarCursor: (i: number) => void;
  aoAbrir: (l: LinhaFilaDto) => void;
  aoImplementar: (l: LinhaFilaDto) => void;
  implementandoId: string | null;
  /** Cache esmaecido: o Chamados não respondeu (Implementar desabilitado). */
  desabilitada: boolean;
}) {
  const selecionaveis = linhas.filter(selecionavel);
  const todos =
    selecionaveis.length > 0 && selecionaveis.every((l) => selecao.has(l.chamado.chamado_id));

  return (
    <div className={cn('rounded-lg border bg-card shadow-cartao', desabilitada && 'opacity-70')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <CaixaMarcacao
                marcado={todos}
                aoMudar={() => aoMudarSelecao(alternarTodos(selecao, linhas))}
                desabilitado={selecionaveis.length === 0 || desabilitada}
                rotuloAcessivel="Selecionar todos os implementáveis"
              />
            </TableHead>
            <TableHead className="w-14">#</TableHead>
            <TableHead>Chamado</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Natureza</TableHead>
            <TableHead>Prioridade</TableHead>
            <TableHead>Sinais</TableHead>
            <TableHead>Forja</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((l, i) => {
            const id = l.chamado.chamado_id;
            const podeSelecionar = selecionavel(l) && !desabilitada;
            return (
              <TableRow
                key={id}
                data-cursor={i === cursor ? '' : undefined}
                aria-selected={selecao.has(id)}
                onClick={() => {
                  aoMudarCursor(i);
                  aoAbrir(l);
                }}
                className={cn(
                  'cursor-pointer',
                  linhaEsmaecida(l) && 'opacity-50',
                  i === cursor && 'bg-accent/60 outline-2 -outline-offset-2 outline-ring/40',
                )}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <CaixaMarcacao
                    marcado={selecao.has(id)}
                    desabilitado={!podeSelecionar}
                    aoMudar={(v) => {
                      const nova = new Set(selecao);
                      if (v) nova.add(id);
                      else nova.delete(id);
                      aoMudarSelecao(nova);
                    }}
                    rotuloAcessivel={`Selecionar #${l.chamado.numero}`}
                  />
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {l.chamado.numero}
                </TableCell>
                <TableCell className="max-w-96">
                  <div className="flex flex-col gap-0.5">
                    <span className="truncate font-medium" title={l.chamado.titulo}>
                      {l.chamado.titulo}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {l.chamado.complexidade ? (
                        <ComplexidadeBadge complexidade={l.chamado.complexidade} />
                      ) : (
                        <span>sem complexidade</span>
                      )}
                      {l.chamado.sistema_nome && <span>{l.chamado.sistema_nome}</span>}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={l.chamado.status} />
                </TableCell>
                <TableCell>
                  <NaturezaBadge natureza={l.chamado.natureza} />
                </TableCell>
                <TableCell>
                  <PrioridadeBadge prioridade={l.chamado.prioridade} />
                </TableCell>
                <TableCell>
                  <Sinais linha={l} />
                </TableCell>
                <TableCell>
                  <CelulaForja
                    linha={l}
                    aoImplementar={aoImplementar}
                    implementando={desabilitada || implementandoId === id}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        ✗ = pré-condição faltando · passe o mouse para ver qual e como resolver ·{' '}
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navegar,{' '}
        <kbd className="font-mono">x</kbd> selecionar, <kbd className="font-mono">Enter</kbd> abrir
      </p>
    </div>
  );
}
