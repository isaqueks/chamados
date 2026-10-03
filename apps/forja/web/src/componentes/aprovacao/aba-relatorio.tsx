import type { ReactNode } from 'react';
import type { RelatorioRegistrado } from '@comum/contratos';
import type { TecnicoDto } from '@comum/dto';
import { NivelVerificacaoBadge } from '@/componentes/badges';
import { BlocoProveniencia } from '@/componentes/execucao/suporte';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { shaCurto } from './regras-aprovar';
import { linhasVerificacao, type MarcaVerificacao } from './verificacao';

/**
 * Aba Relatório (specs/forja/06 §4.3; F-12 "o relatório é o produto"): as
 * seções do `relatorio.v1` na ordem do wireframe. Seções obrigatórias com
 * `houve: false` mostram a `declaracao` — nunca ficam em branco — e "O que não
 * foi feito" está sempre lá (06 §6 princípio 1). Ao lado, "Fatos verificados
 * pela Forja": `sha`, nível e arquivos sensíveis — calculados pelo app, nunca
 * pelo modelo — e "Como foi verificado" (FJ-032): os comandos que o revisor
 * relatou, com exit code, conferidos contra o stream do agente.
 */

const ICONE_MARCA: Record<MarcaVerificacao, string> = { visto: '✓', falhou: '✗', declarado: '?' };
const COR_MARCA: Record<MarcaVerificacao, string> = {
  visto: '',
  falhou: 'text-rose-700 dark:text-rose-300',
  declarado: 'text-amber-700 dark:text-amber-300',
};

const ROTULO_RESULTADO_CA = {
  ok: 'ok',
  falhou: 'falhou',
  nao_testado: 'não testado ponta a ponta',
};

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {titulo}
      </h4>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function ListaOuVazio({ itens, vazio }: { itens: string[]; vazio: string }) {
  if (itens.length === 0) return <p className="text-muted-foreground">{vazio}</p>;
  return (
    <ul className="list-disc pl-5">
      {itens.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export function AbaRelatorio({
  relatorio,
  versao,
  tecnico,
  aoAbrirEvidencias,
}: {
  relatorio: RelatorioRegistrado;
  versao: number;
  tecnico: TecnicoDto | undefined;
  aoAbrirEvidencias: () => void;
}) {
  const r = relatorio;
  // FJ-033; relatórios anteriores não têm o campo.
  const suposicoes = (r.suposicoes_assumidas as string[] | undefined) ?? [];
  const verificacao = tecnico?.veredito?.verificacao;
  const comandos = linhasVerificacao(verificacao?.comandos as readonly unknown[] | undefined);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <BlocoProveniencia origem="agente" titulo={r.titulo}>
        <Secao titulo="Resumo">{r.resumo}</Secao>
        {suposicoes.length > 0 && (
          <Secao titulo="Suposições assumidas">
            <p className="text-muted-foreground">
              O planejador decidiu sozinho; confira antes de aprovar.
            </p>
            <ListaOuVazio itens={suposicoes} vazio="—" />
          </Secao>
        )}
        <Secao titulo="O que muda para quem usa">
          <ListaOuVazio itens={r.o_que_muda_para_quem_usa} vazio="—" />
        </Secao>
        <Secao titulo="Regras de negócio alteradas">
          {r.regras_de_negocio_alteradas.houve ? (
            <ul className="flex flex-col gap-2">
              {r.regras_de_negocio_alteradas.itens.map((it, i) => (
                <li key={i} className="flex flex-col">
                  <span className="font-medium">{it.regra}</span>
                  <span>
                    <span className="text-muted-foreground">Antes:</span> {it.antes}{' '}
                    <span className="text-muted-foreground">Depois:</span> {it.depois}
                  </span>
                  <span className="text-muted-foreground">Quem é afetado: {it.quem_e_afetado}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{r.regras_de_negocio_alteradas.declaracao}</p>
          )}
        </Secao>
        <Secao titulo="Alterações no schema do banco">
          {r.alteracoes_no_schema_do_banco.houve ? (
            <>
              <ul className="flex flex-col gap-1">
                {r.alteracoes_no_schema_do_banco.itens.map((it, i) => (
                  <li key={i}>
                    {it.em_linguagem_simples}{' '}
                    <span className="font-mono text-xs text-muted-foreground">
                      ({it.tipo} {it.objeto_tecnico}
                      {it.afeta_dados_existentes ? ' · afeta dados existentes' : ''}
                      {it.reversivel ? ' · reversível' : ' · irreversível'})
                    </span>
                  </li>
                ))}
              </ul>
              {r.alteracoes_no_schema_do_banco.exige_migracao_no_deploy && (
                <p className="font-medium">Exige rodar a migração no deploy.</p>
              )}
            </>
          ) : (
            <p>
              {r.alteracoes_no_schema_do_banco.declaracao}{' '}
              <span className="text-muted-foreground">(declaração do agente)</span>
            </p>
          )}
        </Secao>
        <Secao titulo="Alterações de interface">
          {r.alteracoes_de_interface.houve ? (
            <div className="flex flex-col gap-1">
              <ul className="list-disc pl-5">
                {r.alteracoes_de_interface.telas.map((t) => (
                  <li key={t.tela_id}>
                    <span className="font-mono text-xs text-muted-foreground">{t.tela_id}</span>{' '}
                    {t.o_que_mudou_para_quem_usa}{' '}
                    <span className="font-mono text-xs text-muted-foreground">{t.rota}</span>
                  </li>
                ))}
              </ul>
              {r.evidencia_visual !== 'completa' && r.evidencia_visual_motivo && (
                <p className="text-amber-800 dark:text-amber-200">
                  Alteração de interface sem prints: {r.evidencia_visual_motivo}
                </p>
              )}
              <div>
                <Button size="xs" variant="outline" onClick={aoAbrirEvidencias}>
                  Antes/depois
                </Button>
              </div>
            </div>
          ) : (
            <p>{r.alteracoes_de_interface.declaracao}</p>
          )}
        </Secao>
        <Secao titulo="Como foi testado">
          {r.como_foi_testado.cenarios.length === 0 ? (
            <p className="text-muted-foreground">Nenhum cenário declarado.</p>
          ) : (
            <p>
              {r.como_foi_testado.cenarios
                .map((c) => `${c.criterio} ${ROTULO_RESULTADO_CA[c.resultado]}`)
                .join(' · ')}
            </p>
          )}
        </Secao>
        <Secao titulo="Como testar manualmente">
          <ol className="list-decimal pl-5">
            {r.como_testar_manualmente.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </Secao>
        <Secao titulo="Riscos e o que observar">
          <ListaOuVazio itens={r.riscos_e_o_que_observar} vazio="Nenhum risco declarado." />
        </Secao>
        <Secao titulo="O que não foi feito">
          <ListaOuVazio
            itens={r.o_que_nao_foi_feito}
            vazio="Nada ficou de fora, segundo o agente."
          />
        </Secao>
        {r.dependencias_novas.length > 0 && (
          <Secao titulo="Dependências novas">
            <ListaOuVazio itens={r.dependencias_novas} vazio="" />
          </Secao>
        )}
        {versao > 1 && (
          <Secao titulo={`Mudou desde a versão ${versao - 1}`}>
            <ListaOuVazio
              itens={r.mudou_desde_a_ultima_versao ?? []}
              vazio="O agente não declarou mudanças."
            />
          </Secao>
        )}
      </BlocoProveniencia>

      <BlocoProveniencia origem="forja" titulo="Fatos verificados pela Forja" className="h-fit">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Nível</dt>
          <dd>
            <NivelVerificacaoBadge nivel={r.nivel_verificacao} />
          </dd>
          <dt className="text-muted-foreground">sha</dt>
          <dd className="font-mono text-xs">{shaCurto(r.sha)}</dd>
          <dt className="text-muted-foreground">Arquivos</dt>
          <dd>
            {r.arquivos} ·{' '}
            <span className="text-emerald-700 dark:text-emerald-300">+{r.linhas.adicoes}</span>{' '}
            <span className="text-rose-700 dark:text-rose-300">−{r.linhas.remocoes}</span>
          </dd>
          <dt className="text-muted-foreground">Sensíveis</dt>
          <dd className="font-mono text-xs break-all">
            {r.sensiveis.length ? r.sensiveis.join(', ') : 'nenhum'}
          </dd>
          {r.condutor_editou && (
            <>
              <dt className="text-muted-foreground">Condutor</dt>
              <dd className="text-amber-700 dark:text-amber-300">
                editou diretamente (sem delegar)
              </dd>
            </>
          )}
        </dl>
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Como foi verificado
          </h4>
          <p className="text-xs text-muted-foreground">
            Os checks foram rodados pelos agentes; a Forja confere o relato do revisor contra o que
            apareceu no stream.
            {verificacao?.motivo ? ` ${verificacao.motivo}.` : ''}
          </p>
          {comandos.length === 0 ? (
            <p className="text-sm text-muted-foreground">O revisor não relatou comandos.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {comandos.map((c, i) => (
                <li key={`${c.comando}-${i}`} className={cn('text-xs', COR_MARCA[c.marca])}>
                  <span className="font-mono break-all">
                    {ICONE_MARCA[c.marca]} {c.comando} · exit {c.exit_code ?? '?'}
                  </span>
                  <span className="block text-muted-foreground">
                    {c.detalhe}
                    {c.resumo ? ` — ${c.resumo}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </BlocoProveniencia>
    </div>
  );
}
