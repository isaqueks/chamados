import { useState } from 'react';
import { CheckIcon, CircleIcon, FileJsonIcon } from 'lucide-react';
import type { PlanoExecucaoDto } from '@comum/dto';
import { SeloBanco, SeloInterface, SeloRegraNegocio } from '@/componentes/badges';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { horaLocal } from '@/lib/formato';
import { BlocoProveniencia, Faixa, TextoSeguro } from './suporte';

/**
 * Coluna do plano na Execução (specs/forja/06 §4.2 "Plano"): entendimento,
 * confiança com justificativa, passos com o estado vindo dos commits do APP
 * (F-08 — nunca da fala do agente), critérios de aceite, `schema_banco`
 * previsto, `fora_de_escopo`, `alertas_seguranca` (faixa vermelha no topo) e
 * as `suposicoes` que o planejador/o app assumiram (FJ-033) e os `avisos` ⚙ do
 * plano — riscos que não pararam no G1 (FJ-034).
 * "Plano completo" abre um sheet com o `plano.v1` legível e a aba JSON.
 *
 * O plano é "escrito pelo agente" (06 §3.3): os selos aqui são PREVISTOS pelo
 * planejador, e o texto deixa isso explícito — os selos ⚙ de verdade só
 * existem na Aprovação, calculados do diff.
 */

const ROTULO_CONFIANCA = {
  alta: 'confiança alta',
  media: 'confiança média',
  baixa: 'confiança baixa',
};
const ROTULO_VERIFICACAO = { unit: 'unit', e2e: 'e2e', manual: 'manual' };

export function PlanoCarregando() {
  return (
    <BlocoProveniencia origem="agente" titulo="Plano">
      <p className="text-sm text-muted-foreground">Fable lendo o chamado (dados do cliente)…</p>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </BlocoProveniencia>
  );
}

export function PainelPlano({ plano }: { plano: PlanoExecucaoDto }) {
  const [aberto, setAberto] = useState(false);
  const p = plano.plano;
  // FJ-033; planos anteriores não têm o campo.
  const suposicoes = (p.suposicoes as string[] | undefined) ?? [];
  // FJ-034 ⚙: riscos que viraram aviso (planos antigos não têm o campo).
  const avisos = (p.avisos as string[] | undefined) ?? [];
  const subtitulo = [
    ROTULO_CONFIANCA[p.confianca],
    plano.aprovado_em ? `aprovado ${horaLocal(plano.aprovado_em)}` : 'não aprovado ainda',
    plano.editado_por_humano ? 'editado por você' : null,
    `versão ${plano.versao}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <BlocoProveniencia
      origem="agente"
      titulo="Plano"
      acoes={
        <Button variant="ghost" size="xs" onClick={() => setAberto(true)}>
          Plano completo
        </Button>
      }
    >
      {p.alertas_seguranca.length > 0 && (
        <Faixa tom="erro" titulo="Alertas de segurança do planejador">
          <ul className="list-disc pl-4">
            {p.alertas_seguranca.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Faixa>
      )}
      {avisos.length > 0 && (
        <Faixa tom="aviso" titulo="Avisos do plano (não pararam a execução)">
          <ul className="list-disc pl-4">
            {avisos.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Faixa>
      )}
      <p className="text-xs text-muted-foreground">{subtitulo}</p>
      <TextoSeguro texto={p.entendimento} />
      <p className="text-xs text-muted-foreground">{p.justificativa_confianca}</p>

      <section aria-label="Passos" className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Passos
        </h4>
        <ol className="flex flex-col gap-1 text-sm">
          {plano.passos.map((passo) => (
            <li key={passo.id} className="flex items-start gap-2">
              <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">
                {passo.id}
              </span>
              <span className="flex-1">{passo.descricao}</span>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 text-xs',
                  passo.estado === 'feito' && 'text-emerald-700 dark:text-emerald-300',
                  passo.estado === 'em_andamento' && 'text-violet-700 dark:text-violet-300',
                  passo.estado === 'pendente' && 'text-muted-foreground',
                )}
              >
                {passo.estado === 'feito' ? (
                  <CheckIcon className="size-3" aria-hidden />
                ) : (
                  <CircleIcon
                    className={cn('size-3', passo.estado === 'em_andamento' && 'fill-current')}
                    aria-hidden
                  />
                )}
                {passo.estado === 'feito'
                  ? `commit ${passo.sha_commit?.slice(0, 7) ?? ''}`
                  : passo.estado === 'em_andamento'
                    ? 'em andamento'
                    : 'pendente'}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {suposicoes.length > 0 && (
        <section aria-label="Suposições assumidas" className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Suposições assumidas
          </h4>
          <ul className="list-disc pl-4 text-sm">
            {suposicoes.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      {p.criterios_de_aceite.length > 0 && (
        <section aria-label="Critérios de aceite" className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Critérios de aceite
          </h4>
          <ul className="flex flex-col gap-1 text-sm">
            {p.criterios_de_aceite.map((ca) => (
              <li key={ca.id} className="flex items-start gap-2">
                <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">
                  {ca.id}
                </span>
                <span className="flex-1">{ca.descricao}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ROTULO_VERIFICACAO[ca.verificacao]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <SeloBanco altera={p.schema_banco.altera} />
        <SeloRegraNegocio altera={p.regras_de_negocio.length > 0} />
        <SeloInterface telas={p.telas_afetadas.length} />
        <span className="text-xs text-muted-foreground">(previsto pelo plano)</span>
      </div>

      {p.fora_de_escopo.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">Fora de escopo: </span>
          {p.fora_de_escopo.join('; ')}
        </p>
      )}

      <PlanoCompleto plano={plano} aberto={aberto} aoFechar={() => setAberto(false)} />
    </BlocoProveniencia>
  );
}

function Lista({ titulo, itens }: { titulo: string; itens: string[] }) {
  if (itens.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{titulo}</h4>
      <ul className="list-disc pl-5 text-sm">
        {itens.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

/** Sheet "Plano completo": o `plano.v1` legível e a aba JSON (06 §4.2). */
export function PlanoCompleto({
  plano,
  aberto,
  aoFechar,
}: {
  plano: PlanoExecucaoDto;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const p = plano.plano;
  return (
    <Sheet open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Plano completo · versão {plano.versao}</SheetTitle>
          <SheetDescription>Escrito pelo agente planejador (somente leitura).</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="legivel" className="px-4 pb-6">
          <TabsList>
            <TabsTrigger value="legivel">Legível</TabsTrigger>
            <TabsTrigger value="json">
              <FileJsonIcon aria-hidden /> JSON
            </TabsTrigger>
          </TabsList>
          <TabsContent value="legivel" className="flex flex-col gap-4 pt-2">
            <TextoSeguro texto={p.entendimento} />
            <Lista
              titulo="Suposições assumidas"
              itens={(p.suposicoes as string[] | undefined) ?? []}
            />
            <Lista
              titulo="Passos"
              itens={p.passos.map(
                (x) => `${x.id} · ${x.descricao} (${x.arquivos_previstos.join(', ')})`,
              )}
            />
            <Lista
              titulo="Critérios de aceite"
              itens={p.criterios_de_aceite.map(
                (c) => `${c.id} · ${c.descricao} [${c.verificacao}]`,
              )}
            />
            <Lista
              titulo="Regras de negócio"
              itens={p.regras_de_negocio.map(
                (r) => `${r.regra}: antes ${r.antes}; depois ${r.depois}`,
              )}
            />
            <Lista
              titulo="Banco de dados"
              itens={p.schema_banco.mudancas.map(
                (m) =>
                  `${m.tipo} ${m.objeto}: ${m.descricao}${m.reversivel ? ' (reversível)' : ''}`,
              )}
            />
            <Lista
              titulo="Telas afetadas"
              itens={p.telas_afetadas.map((t) => `${t.id} · ${t.descricao} · ${t.rota}`)}
            />
            <Lista
              titulo="Riscos"
              itens={p.riscos.map((r) => `${r.descricao} (${r.severidade})`)}
            />
            <Lista
              titulo="Dependências previstas"
              itens={p.dependencias_previstas.map((d) => `${d.pacote}: ${d.motivo}`)}
            />
            <Lista titulo="Fora de escopo" itens={p.fora_de_escopo} />
            <Lista titulo="Evidências investigadas" itens={p.evidencias} />
          </TabsContent>
          <TabsContent value="json" className="pt-2">
            <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/60 p-3 font-mono text-xs">
              {JSON.stringify(p, null, 2)}
            </pre>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
