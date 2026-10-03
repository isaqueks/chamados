import type { TecnicoDto } from '@comum/dto';
import { formatarCustoEquivalente } from '@/lib/formato';
import { ROTULO_ETAPA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { BlocoProveniencia, Faixa } from '@/componentes/execucao/suporte';
import { formatarDuracao, duracaoEntre, nomeModelo } from '@/componentes/execucao/formato-execucao';

/**
 * Aba Técnico (specs/forja/06 §4.3): veredito com achados por severidade (os
 * descartados em caixa amarela), negações de permissão, `session_id` por
 * etapa, custo por etapa e modelo, branch, `sha_base`, `sha` atual,
 * `patch-id` completo e o preview da nota interna que o outbox vai publicar.
 * É o único lugar da Aprovação com identificadores crus (06 §3.2).
 */

const ORDEM_SEVERIDADE = { bloqueante: 0, importante: 1, sugestao: 2 } as const;

const CLASSE_SEVERIDADE = {
  bloqueante: 'text-rose-700 dark:text-rose-300',
  importante: 'text-amber-700 dark:text-amber-300',
  sugestao: 'text-muted-foreground',
} as const;

export function AbaTecnico({ tecnico }: { tecnico: TecnicoDto }) {
  const t = tecnico;
  const v = t.veredito;
  const achados = v
    ? [...v.achados].sort((a, b) => ORDEM_SEVERIDADE[a.severidade] - ORDEM_SEVERIDADE[b.severidade])
    : [];
  const repetidos = new Set(v?.repetidos ?? []);

  return (
    <div className="flex flex-col gap-4">
      {t.negacoes.length > 0 && (
        <Faixa
          tom="erro"
          titulo={`${t.negacoes.length} negações de permissão (regras deny da Forja)`}
        >
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {t.negacoes.map((n, i) => (
              <li key={i}>
                etapa {n.etapa_n} · {n.ferramenta}({n.resumo})
              </li>
            ))}
          </ul>
        </Faixa>
      )}

      <BlocoProveniencia origem="agente" titulo="Veredito da revisão">
        {!v ? (
          <p className="text-sm text-muted-foreground">Sem veredito registrado.</p>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">{v.decisao}</span> · recomendação {v.recomendacao}:{' '}
              {v.motivo_recomendacao}
            </p>
            {!v.valido && v.motivo_invalido && (
              <Faixa tom="aviso" titulo="Veredito descartado pela Forja">
                {v.motivo_invalido}
              </Faixa>
            )}
            {achados.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum achado.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {achados.map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 rounded-md border p-2 text-sm">
                    <span>
                      <span className={cn('font-medium', CLASSE_SEVERIDADE[a.severidade])}>
                        {a.severidade}
                      </span>{' '}
                      <span className="font-mono text-xs text-muted-foreground">
                        {a.id} · {a.revisor} · {a.categoria} · {a.arquivo}
                        {a.linha ? `:${a.linha}` : ''}
                      </span>
                      {repetidos.has(a.id) && (
                        <span className="ml-1 text-xs">(voltou: pingue-pongue)</span>
                      )}
                    </span>
                    <span>{a.descricao}</span>
                    <span className="text-muted-foreground">Sugestão: {a.sugestao}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </BlocoProveniencia>

      <BlocoProveniencia origem="forja" titulo="Etapas e sessões">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Etapa</TableHead>
              <TableHead>Ciclo</TableHead>
              <TableHead>Modelo</TableHead>
              <TableHead>session_id</TableHead>
              <TableHead>Duração</TableHead>
              <TableHead>Custo</TableHead>
              <TableHead>Negações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.etapas.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{e.n}</TableCell>
                <TableCell>
                  {ROTULO_ETAPA[e.tipo]}{' '}
                  <span className="text-xs text-muted-foreground">({e.estado})</span>
                  {e.condutor_editou && (
                    <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                      ▲ Fable editou
                    </span>
                  )}
                </TableCell>
                <TableCell>{e.ciclo}</TableCell>
                <TableCell>{nomeModelo(e.modelo) ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{e.session_id ?? '—'}</TableCell>
                <TableCell>{formatarDuracao(duracaoEntre(e.inicio, e.fim)) ?? '—'}</TableCell>
                <TableCell>
                  {e.custo_micro_usd !== null ? formatarCustoEquivalente(e.custo_micro_usd) : '—'}
                </TableCell>
                <TableCell
                  className={e.negacoes > 0 ? 'font-medium text-rose-700 dark:text-rose-300' : ''}
                >
                  {e.negacoes}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">branch</dt>
          <dd className="break-all">{t.branch ?? '—'}</dd>
          <dt className="text-muted-foreground">sha_base</dt>
          <dd className="break-all">{t.sha_base ?? '—'}</dd>
          <dt className="text-muted-foreground">sha atual</dt>
          <dd className="break-all">{t.sha_atual ?? '—'}</dd>
          <dt className="text-muted-foreground">patch-id</dt>
          <dd className="break-all">{t.patch_id ?? '—'}</dd>
        </dl>
        {t.sentinela && t.sentinela.divergencias.length > 0 && (
          <p className="text-sm text-rose-700 dark:text-rose-300">
            Sentinela: {t.sentinela.divergencias.join(', ')}
            {t.sentinela.reconhecida_em ? ' (reconhecida)' : ''}
          </p>
        )}
      </BlocoProveniencia>

      <BlocoProveniencia origem="forja" titulo="Nota interna que o outbox vai publicar">
        <pre className="text-sm whitespace-pre-wrap">{t.nota_interna_preview}</pre>
      </BlocoProveniencia>
    </div>
  );
}
