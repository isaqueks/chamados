import { Brain } from 'lucide-react';
import type { SistemaAlvoResumo, ExecucaoIAView } from '@chamados/db';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ExecucaoIABadge } from '@/components/chamado/badges';
import { ROTULO_GATILHO_IA } from '@/lib/rotulos';
import { dataHora, tempoRelativo } from '@/lib/tempo';
import { MapearSistema } from './mapear-sistema';

/**
 * Card "Conhecimento do sistema" (D-013). Mostra o estado do mapa (nunca mapeado /
 * gerado em X no commit Y / última tentativa em andamento ou falha), o botão
 * "Mapear agora" (admin — enfileira o mapeamento), um preview colapsável do resumo
 * e as execuções de mapeamento recentes do sistema.
 */
export function ConhecimentoSistemaCard({
  sistema,
  execucoes,
}: {
  sistema: SistemaAlvoResumo;
  execucoes: ExecucaoIAView[];
}) {
  const temMapa = !!sistema.conhecimento_resumo;
  const commitCurto = sistema.conhecimento_commit ? sistema.conhecimento_commit.slice(0, 10) : null;
  const ultima = execucoes[0];
  const emAndamento = ultima?.status === 'executando' || ultima?.status === 'na_fila';
  const ultimaFalhou = ultima?.status === 'falhou';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Brain className="size-4 text-marca-acento" />
            Conhecimento do sistema
          </CardTitle>
          <CardDescription>
            Um resumo do repositório que a IA usa em toda triagem. Atualiza sozinho quando o código
            muda; use &ldquo;Mapear agora&rdquo; para forçar.
          </CardDescription>
        </div>
        <MapearSistema sistemaAlvoId={sistema.id} />
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Estado do mapa */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {temMapa ? (
            <>
              <Badge variant="default">Mapeado</Badge>
              <span className="text-muted-foreground">
                gerado{' '}
                {sistema.conhecimento_gerado_em
                  ? tempoRelativo(sistema.conhecimento_gerado_em)
                  : '—'}
                {sistema.conhecimento_gerado_em ? (
                  <span title={dataHora(sistema.conhecimento_gerado_em)} />
                ) : null}
                {commitCurto ? ` · commit ${commitCurto}` : ''}
              </span>
            </>
          ) : (
            <Badge variant="muted">Nunca mapeado</Badge>
          )}
          {emAndamento && <Badge variant="secondary">Mapeando…</Badge>}
          {ultimaFalhou && !emAndamento && (
            <Badge variant="outline" className="border-rose-300 text-rose-700">
              Última tentativa falhou
            </Badge>
          )}
        </div>

        {/* Preview colapsável do resumo */}
        {temMapa && (
          <details className="rounded-lg border bg-background/40">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              Ver resumo
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-3 pb-3 text-xs leading-relaxed text-muted-foreground">
              {sistema.conhecimento_resumo}
            </pre>
          </details>
        )}

        {/* Execuções de mapeamento recentes */}
        {execucoes.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Execuções de mapeamento</p>
            <ul className="flex flex-col gap-2">
              {execucoes.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-1 rounded-lg border bg-background/40 p-3"
                >
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
                    {e.custo_usd !== null && <span>US$ {Number(e.custo_usd).toFixed(4)}</span>}
                    {e.tokens_entrada !== null && e.tokens_saida !== null && (
                      <span>
                        {e.tokens_entrada}↑ / {e.tokens_saida}↓ tokens
                      </span>
                    )}
                  </div>
                  {e.erro && <p className="text-xs text-rose-700">Erro: {e.erro}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
