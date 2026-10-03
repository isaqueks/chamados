import type { ReactNode } from 'react';
import { ShieldAlertIcon } from 'lucide-react';
import type { PlanoRegistrado } from '@comum/contratos';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { SeloBanco } from '@/componentes/badges';

/**
 * "Ver plano" da mesa (specs/forja/06 §4.4 e §4.2 "Plano completo"): o
 * `plano.v1` legível e a aba JSON. É texto ESCRITO PELO AGENTE (06 §3.3) —
 * superfície `card` normal, com o rótulo de proveniência no topo. Alertas de
 * segurança vêm primeiro, em faixa vermelha.
 */

const ROTULO_CONFIANCA = { alta: 'alta', media: 'média', baixa: 'baixa' } as const;
const ROTULO_VERIFICACAO = { unit: 'unit', e2e: 'e2e', manual: 'manual' } as const;

function Bloco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {titulo}
      </h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

export function PlanoLegivel({ plano }: { plano: PlanoRegistrado }) {
  // FJ-033; planos anteriores não têm o campo.
  const suposicoes = (plano.suposicoes as string[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-4">
      {plano.alertas_seguranca.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
          <span className="flex items-center gap-1.5 font-medium">
            <ShieldAlertIcon className="size-4" aria-hidden />
            Alertas de segurança
          </span>
          <ul className="list-disc pl-5">
            {plano.alertas_seguranca.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      <Bloco titulo="Entendimento">
        <p className="whitespace-pre-wrap">{plano.entendimento}</p>
      </Bloco>
      <Bloco titulo="Confiança">
        <p>
          <span className="font-medium">{ROTULO_CONFIANCA[plano.confianca]}</span> —{' '}
          {plano.justificativa_confianca}
        </p>
      </Bloco>
      {plano.natureza_confirmada === 'nao_implementavel' && (
        <Bloco titulo="Não implementável">
          <p>{plano.motivo_nao_implementavel ?? '—'}</p>
        </Bloco>
      )}
      {suposicoes.length > 0 && (
        <Bloco titulo="Suposições assumidas">
          <ul className="list-disc pl-5">
            {suposicoes.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </Bloco>
      )}
      {plano.perguntas_ao_cliente.length > 0 && (
        <Bloco titulo="Perguntas ao cliente">
          <ul className="flex flex-col gap-2">
            {plano.perguntas_ao_cliente.map((p, i) => (
              <li key={i} className="rounded-md border p-2">
                <p className="font-medium">{p.pergunta}</p>
                <p className="text-xs text-muted-foreground">
                  Por que importa: {p.por_que_importa}
                </p>
                <p className="text-xs text-muted-foreground">
                  Suposição padrão: {p.suposicao_padrao}
                </p>
              </li>
            ))}
          </ul>
        </Bloco>
      )}
      {plano.decisoes_do_operador.length > 0 && (
        <Bloco titulo="Decisões suas">
          <ul className="flex flex-col gap-2">
            {plano.decisoes_do_operador.map((d, i) => (
              <li key={i} className="rounded-md border p-2">
                <p className="font-medium">{d.questao}</p>
                <p className="text-xs text-muted-foreground">Opções: {d.opcoes.join(' · ')}</p>
                <p className="text-xs text-muted-foreground">Recomendação: {d.recomendacao}</p>
              </li>
            ))}
          </ul>
        </Bloco>
      )}
      <Bloco titulo={`Passos (${plano.passos.length})`}>
        <ol className="flex flex-col gap-1.5">
          {plano.passos.map((p) => (
            <li key={p.id} className="flex flex-col">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{p.id}</span>{' '}
                {p.descricao}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {p.arquivos_previstos.join(', ')}
              </span>
            </li>
          ))}
        </ol>
      </Bloco>
      <Bloco titulo="Critérios de aceite">
        <ul className="flex flex-col gap-1">
          {plano.criterios_de_aceite.map((c) => (
            <li key={c.id}>
              <span className="font-mono text-xs text-muted-foreground">{c.id}</span> {c.descricao}{' '}
              <span className="text-xs text-muted-foreground">
                ({ROTULO_VERIFICACAO[c.verificacao]})
              </span>
            </li>
          ))}
        </ul>
      </Bloco>
      <Bloco titulo="Banco de dados (previsto)">
        <div className="flex flex-col gap-1.5">
          <SeloBanco altera={plano.schema_banco.altera} />
          {plano.schema_banco.mudancas.map((m, i) => (
            <p key={i}>
              <span className="font-medium">{m.objeto}</span> — {m.descricao}{' '}
              <span className="text-xs text-muted-foreground">
                ({m.reversivel ? 'reversível' : 'irreversível'})
              </span>
            </p>
          ))}
        </div>
      </Bloco>
      {plano.regras_de_negocio.length > 0 && (
        <Bloco titulo="Regras de negócio">
          <ul className="flex flex-col gap-1.5">
            {plano.regras_de_negocio.map((r, i) => (
              <li key={i}>
                <p className="font-medium">{r.regra}</p>
                <p className="text-xs text-muted-foreground">
                  Antes: {r.antes} · Depois: {r.depois}
                </p>
              </li>
            ))}
          </ul>
        </Bloco>
      )}
      {plano.telas_afetadas.length > 0 && (
        <Bloco titulo="Telas afetadas">
          <ul className="flex flex-col gap-1">
            {plano.telas_afetadas.map((t) => (
              <li key={t.id}>
                <span className="font-mono text-xs text-muted-foreground">{t.id}</span>{' '}
                {t.descricao} <span className="font-mono text-xs">{t.rota}</span>
              </li>
            ))}
          </ul>
        </Bloco>
      )}
      {plano.riscos.length > 0 && (
        <Bloco titulo="Riscos">
          <ul className="list-disc pl-5">
            {plano.riscos.map((r, i) => (
              <li key={i}>
                {r.descricao}{' '}
                <span className="text-xs text-muted-foreground">({r.severidade})</span>
              </li>
            ))}
          </ul>
        </Bloco>
      )}
      {plano.fora_de_escopo.length > 0 && (
        <Bloco titulo="Fora de escopo">
          <ul className="list-disc pl-5">
            {plano.fora_de_escopo.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </Bloco>
      )}
    </div>
  );
}

export function SheetPlano({
  plano,
  titulo,
  aberto,
  aoMudarAberto,
}: {
  plano: PlanoRegistrado | null;
  titulo: string;
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
}) {
  return (
    <Sheet open={aberto} onOpenChange={aoMudarAberto}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{titulo}</SheetTitle>
          <SheetDescription>Escrito pelo agente (planejador, somente leitura).</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {plano ? (
            <Tabs defaultValue="legivel">
              <TabsList>
                <TabsTrigger value="legivel">Plano</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="legivel" className="pt-3">
                <PlanoLegivel plano={plano} />
              </TabsContent>
              <TabsContent value="json" className="pt-3">
                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(plano, null, 2)}
                </pre>
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-sm text-muted-foreground">O plano ainda não foi emitido.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
