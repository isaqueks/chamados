import { Sparkles, GitPullRequest, ExternalLink } from 'lucide-react';
import type { ExecucaoIAView } from '@chamados/db';
import { ExecucaoIABadge } from '@/components/chamado/badges';
import { ROTULO_GATILHO_IA } from '@/lib/rotulos';
import { dataHora, tempoRelativo } from '@/lib/tempo';
import { ReexecutarTriagem } from './reexecutar-triagem';

/**
 * Painel "Assistente IA" (specs/08 §4.3) — VISÍVEL só a operador/admin (o cliente
 * nunca vê `ExecucaoIA`). Lista as execuções de triagem do chamado (status,
 * gatilho, provider/modelo, duração, custo, erro, horário) e oferece o botão
 * "Reexecutar triagem" (reprocessamento manual — specs/05 §2). O RESULTADO da IA
 * (diagnóstico/classificação/PR) passa a ser aplicado ao chamado no M7; aqui é a
 * trilha de execuções da infraestrutura entregue no M6.
 */
export function AssistenteIA({
  nomeAssistente,
  chamadoId,
  execucoes,
  podeReexecutar,
}: {
  nomeAssistente: string;
  chamadoId: string;
  execucoes: ExecucaoIAView[];
  podeReexecutar: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-marca-acento/10 text-marca-acento">
          <Sparkles className="size-4" />
        </span>
        <h3 className="font-heading text-sm font-semibold">{nomeAssistente}</h3>
        {execucoes.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {execucoes.length} execução(ões)
          </span>
        )}
      </div>

      {execucoes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center">
          <p className="text-sm font-medium">Nenhuma triagem executada ainda</p>
          <p className="text-xs text-muted-foreground">
            A triagem automática roda ao abrir o chamado e quando o cliente responde. Você também
            pode acioná-la manualmente.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {execucoes.map((e) => (
            <li key={e.id} className="flex flex-col gap-1.5 rounded-lg border bg-background/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <ExecucaoIABadge status={e.status} />
                <span className="text-xs text-muted-foreground">
                  {ROTULO_GATILHO_IA[e.gatilho] ?? e.gatilho}
                </span>
                <span
                  className="ml-auto text-xs text-muted-foreground"
                  title={dataHora(e.created_at)}
                >
                  {tempoRelativo(e.created_at)}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  {e.provider} · {e.modelo}
                </span>
                {e.duracao_ms !== null && <span>{formatarDuracao(e.duracao_ms)}</span>}
                {e.custo_usd !== null && <span>{formatarCusto(e.custo_usd)}</span>}
                {e.tokens_entrada !== null && e.tokens_saida !== null && (
                  <span>
                    {e.tokens_entrada}↑ / {e.tokens_saida}↓ tokens
                  </span>
                )}
              </div>

              {e.erro && (
                <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                  Erro: {e.erro}
                </p>
              )}
              {e.status === 'concluido' && e.resultado?.diagnostico && (
                <p className="line-clamp-3 text-xs text-foreground/80">{e.resultado.diagnostico}</p>
              )}
              {e.resultado?.tentativaResolucao && (
                <TentativaResolucaoBloco tentativa={e.resultado.tentativaResolucao} />
              )}
            </li>
          ))}
        </ul>
      )}

      {podeReexecutar && (
        <div className="flex justify-end">
          <ReexecutarTriagem chamadoId={chamadoId} />
        </div>
      )}
    </div>
  );
}

/** Bloco da tentativa de resolução automática (branch, PR, resumo, arquivos). */
function TentativaResolucaoBloco({
  tentativa,
}: {
  tentativa: NonNullable<NonNullable<ExecucaoIAView['resultado']>['tentativaResolucao']>;
}) {
  const falhou = tentativa.situacao === 'falhou';
  return (
    <div
      className={
        'flex flex-col gap-1.5 rounded-md border p-2 text-xs ' +
        (falhou
          ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20'
          : 'border-violet-300 bg-violet-50/60 dark:border-violet-900/50 dark:bg-violet-950/20')
      }
    >
      <div className="flex items-center gap-1.5 font-medium">
        <GitPullRequest className="size-3.5" />
        {falhou ? 'Tentativa de resolução falhou' : 'Resolução automática — PR'}
      </div>
      {tentativa.resumo && <p className="text-foreground/80">{tentativa.resumo}</p>}
      {tentativa.branch && (
        <p className="font-mono text-[11px] break-all text-muted-foreground">{tentativa.branch}</p>
      )}
      {tentativa.arquivosAlterados.length > 0 && (
        <p className="text-muted-foreground">Arquivos: {tentativa.arquivosAlterados.join(', ')}</p>
      )}
      {tentativa.prUrl ? (
        <a
          href={tentativa.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 rounded border bg-background px-2 py-1 font-medium hover:bg-accent"
        >
          Abrir Pull Request <ExternalLink className="size-3" />
        </a>
      ) : (
        !falhou &&
        tentativa.branch && (
          <p className="text-muted-foreground">
            Branch publicada — abra o PR manualmente no provedor git. Merge/deploy sempre manual.
          </p>
        )
      )}
    </div>
  );
}

/** Duração legível (ms → "1,2 s" ou "820 ms"). */
function formatarDuracao(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
}

/** Custo em USD legível (numeric string). */
function formatarCusto(usd: string): string {
  const n = Number(usd);
  if (!Number.isFinite(n)) return `$${usd}`;
  return `$${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
