import 'react-diff-view/style/index.css';
import { useMemo } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import { CheckIcon } from 'lucide-react';
import type { DiffArquivoDto, DiffDto, SeloArquivo } from '@comum/dto';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { CaixaMarcacao, RotuloOrigem, Tecla } from '@/componentes/execucao/suporte';
import { analisarArquivo } from './diff';
import { shaCurto } from './regras-aprovar';
import { Segmentado } from '@/ui/segmentado';

/**
 * Visor de diff da Aprovação (specs/forja/06 §4.3 abas Diff e Interdiff; §7
 * "Diff e terminal"): árvore de arquivos com os selos por arquivo
 * (banco/regra/sensível/interface), diff lado a lado ou unificado e o marcador
 * "visto" (`V`) por arquivo. Arquivos com selo vêm primeiro (a ordem chega
 * pronta de `ordenarArquivosDiff`).
 *
 * Cores de adição/remoção na família emerald/rose dos badges, via as
 * variáveis CSS do `react-diff-view` apontadas para os tokens; os sinais `+`
 * e `−` ficam SEMPRE visíveis (não depender de cor, 06 §9). Teclado: `n`/`p`
 * próximo/anterior arquivo e `v` marca visto — ligados pela tela.
 */

const ROTULO_SELO: Record<SeloArquivo, string> = {
  sensivel: 'sensível',
  banco: 'banco',
  regra_negocio: 'regra',
  frontend: 'UI',
};

const CLASSE_SELO: Record<SeloArquivo, string> = {
  sensivel: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  banco: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  regra_negocio: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  frontend: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
};

/** Variáveis do react-diff-view → tokens (claro e escuro) e sinais +/− visíveis. */
const TEMA_DIFF = cn(
  '[--diff-text-color:var(--foreground)] [--diff-font-family:var(--font-mono)]',
  '[--diff-code-insert-background-color:var(--color-emerald-50)] [--diff-gutter-insert-background-color:var(--color-emerald-100)]',
  '[--diff-code-delete-background-color:var(--color-rose-50)] [--diff-gutter-delete-background-color:var(--color-rose-100)]',
  '[--diff-code-insert-edit-background-color:var(--color-emerald-200)] [--diff-code-delete-edit-background-color:var(--color-rose-200)]',
  'dark:[--diff-code-insert-background-color:color-mix(in_oklab,var(--color-emerald-950)_60%,transparent)] dark:[--diff-gutter-insert-background-color:var(--color-emerald-950)]',
  'dark:[--diff-code-delete-background-color:color-mix(in_oklab,var(--color-rose-950)_60%,transparent)] dark:[--diff-gutter-delete-background-color:var(--color-rose-950)]',
  'dark:[--diff-code-insert-edit-background-color:var(--color-emerald-800)] dark:[--diff-code-delete-edit-background-color:var(--color-rose-800)]',
  '[--diff-selection-background-color:var(--accent)]',
  'text-xs',
  "[&_.diff-code-insert]:before:pr-2 [&_.diff-code-insert]:before:text-emerald-700 [&_.diff-code-insert]:before:content-['+'] dark:[&_.diff-code-insert]:before:text-emerald-300",
  "[&_.diff-code-delete]:before:pr-2 [&_.diff-code-delete]:before:text-rose-700 [&_.diff-code-delete]:before:content-['−'] dark:[&_.diff-code-delete]:before:text-rose-300",
  "[&_.diff-code-normal]:before:pr-2 [&_.diff-code-normal]:before:content-['_']",
  '[&_.diff-gutter]:text-muted-foreground',
);

export type ModoVisao = 'split' | 'unified';

export function VisorDiff({
  diff,
  arquivos,
  indice,
  aoMudarIndice,
  vistos,
  aoMarcarVisto,
  arquivosSelo,
  modo,
  aoMudarModo,
  somenteSensiveis,
  aoAlternarSensiveis,
}: {
  diff: DiffDto;
  /** Já ordenados (e filtrados, se "só sensíveis"). */
  arquivos: DiffArquivoDto[];
  indice: number;
  aoMudarIndice: (i: number) => void;
  vistos: ReadonlySet<string>;
  aoMarcarVisto: (caminho: string, visto: boolean) => void;
  arquivosSelo: readonly string[];
  modo: ModoVisao;
  aoMudarModo: (m: ModoVisao) => void;
  somenteSensiveis: boolean;
  aoAlternarSensiveis: () => void;
}) {
  const atual = arquivos[indice] ?? null;
  const analisado = useMemo(() => (atual ? analisarArquivo(atual) : null), [atual]);
  const exigidos = new Set(arquivosSelo);
  const totalExigidos = arquivosSelo.length;
  const vistosExigidos = arquivosSelo.filter((c) => vistos.has(c)).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-mono">
          {shaCurto(diff.sha_de)} → {shaCurto(diff.sha_para)}
          {diff.patch_id && ` · patch ${diff.patch_id.slice(0, 6)}`}
          {diff.truncado && ' · diff truncado (arquivos grandes resumidos)'}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {totalExigidos > 0 && (
            <span>
              arquivos de selo vistos: {vistosExigidos}/{totalExigidos}
            </span>
          )}
          <Button
            size="xs"
            variant={somenteSensiveis ? 'default' : 'outline'}
            onClick={aoAlternarSensiveis}
          >
            Só sensíveis
          </Button>
          <Segmentado
            rotuloAcessivel="Modo do diff"
            valor={modo}
            aoMudar={aoMudarModo}
            opcoes={
              [
                ['split', 'Lado a lado'],
                ['unified', 'Unificado'],
              ] as const
            }
          />
          <RotuloOrigem origem="forja" />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav
          aria-label="Arquivos alterados"
          className="flex max-h-[65vh] flex-col overflow-y-auto rounded-lg border bg-card"
        >
          {arquivos.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">Nenhum arquivo neste filtro.</p>
          )}
          {arquivos.map((a, i) => {
            const visto = vistos.has(a.caminho);
            return (
              <div
                key={a.caminho}
                className={cn(
                  'flex items-start gap-2 border-b px-2 py-1.5 last:border-b-0',
                  i === indice && 'bg-accent',
                )}
              >
                <CaixaMarcacao
                  marcado={visto}
                  aoMudar={(v) => aoMarcarVisto(a.caminho, v)}
                  rotuloAcessivel={`Marcar ${a.caminho} como visto`}
                  className="mt-0.5"
                />
                <button
                  type="button"
                  onClick={() => aoMudarIndice(i)}
                  aria-current={i === indice ? 'true' : undefined}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span
                      className="w-3 shrink-0 font-mono text-[0.7rem] text-muted-foreground"
                      title="status git"
                    >
                      {a.status}
                    </span>
                    <span className="truncate font-mono text-xs" title={a.caminho}>
                      {a.caminho}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1 pl-4.5 text-[0.7rem]">
                    <span className="text-emerald-700 dark:text-emerald-300">+{a.adicoes}</span>
                    <span className="text-rose-700 dark:text-rose-300">−{a.remocoes}</span>
                    {a.selos.map((s) => (
                      <span key={s} className={cn('rounded px-1 font-medium', CLASSE_SELO[s])}>
                        {ROTULO_SELO[s]}
                      </span>
                    ))}
                    {exigidos.has(a.caminho) && !visto && (
                      <span className="text-amber-700 dark:text-amber-300">marcar visto</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-2">
          {atual ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm break-all">
                  {atual.caminho_anterior && atual.caminho_anterior !== atual.caminho
                    ? `${atual.caminho_anterior} → ${atual.caminho}`
                    : atual.caminho}
                </span>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    <Tecla>n</Tecla>/<Tecla>p</Tecla> arquivos
                  </span>
                  <Button
                    size="xs"
                    variant={vistos.has(atual.caminho) ? 'default' : 'outline'}
                    onClick={() => aoMarcarVisto(atual.caminho, !vistos.has(atual.caminho))}
                  >
                    {vistos.has(atual.caminho) && <CheckIcon aria-hidden />}
                    Visto <Tecla>v</Tecla>
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border bg-card">
                {atual.binario ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    Arquivo binário: sem diff de texto.
                  </p>
                ) : !analisado ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    Não foi possível ler o diff deste arquivo. Veja-o na worktree pelo Terminal.
                  </p>
                ) : analisado.hunks.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">Sem mudanças de conteúdo.</p>
                ) : (
                  <Diff
                    viewType={modo}
                    diffType={analisado.tipo}
                    hunks={analisado.hunks}
                    className={TEMA_DIFF}
                  >
                    {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
                  </Diff>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Selecione um arquivo.</p>
          )}
        </div>
      </div>
    </div>
  );
}
