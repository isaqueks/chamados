import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  CircleIcon,
  DiamondIcon,
  Loader2Icon,
  OctagonXIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TriangleIcon,
} from 'lucide-react';
import type { CartaoPlanoDto, ClasseCartaoPlano } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { Textarea } from '@/ui/textarea';
import { EstadoExecucaoBadge, SeloBanco } from '@/componentes/badges';
import { Caixa, Campo } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { formatarDecorrido, plural } from '@/componentes/apoio/texto';
import { DialogoEuDecido, DialogoPerguntarCliente } from './decisao';
import { DialogoDescartar } from './descartar';
import { cartaoPendente, classeEfetiva } from './logica';

/**
 * Cartão de um plano na Mesa (specs/forja/06 §4.4). Cada classe tem as suas
 * ações — e só elas:
 *
 * | classe              | ações                                                        |
 * | ------------------- | ------------------------------------------------------------ |
 * | limpo               | checkbox (aprovação em bloco), Ver plano, Comentar, Descartar |
 * | decisao             | Perguntar ao cliente, Eu decido, Descartar                   |
 * | schema              | Aprovar este plano (individual, F-14), Comentar, Descartar   |
 * | alerta_seguranca    | Ver plano, Aprovar mesmo assim… (digita o nº), Descartar     |
 * | precisa_revisao     | Ver plano, Aprovar este plano, Comentar, Descartar           |
 * | planejando          | — (cronômetro)                                               |
 * | erro                | Tentar de novo, Descartar do lote                            |
 *
 * Cartão já decidido (o plano foi aprovado e a execução seguiu) mostra só o
 * estado e [Abrir].
 */

const VISUAL_CLASSE: Record<
  ClasseCartaoPlano,
  { rotulo: string; icone: typeof CircleIcon; classe: string }
> = {
  limpo: {
    rotulo: 'Limpo',
    icone: SparklesIcon,
    classe: 'text-emerald-700 dark:text-emerald-400',
  },
  decisao: {
    rotulo: 'Decisão necessária',
    icone: DiamondIcon,
    classe: 'text-amber-700 dark:text-amber-400',
  },
  schema: {
    rotulo: 'Altera o banco',
    icone: DiamondIcon,
    classe: 'text-rose-700 dark:text-rose-300',
  },
  alerta_seguranca: {
    rotulo: 'Alerta de segurança',
    icone: ShieldAlertIcon,
    classe: 'text-rose-700 dark:text-rose-300',
  },
  precisa_revisao: {
    rotulo: 'Precisa de revisão',
    icone: DiamondIcon,
    classe: 'text-amber-700 dark:text-amber-400',
  },
  planejando: {
    rotulo: 'Planejando',
    icone: CircleIcon,
    classe: 'text-violet-700 dark:text-violet-300',
  },
  erro: { rotulo: 'Erro', icone: TriangleIcon, classe: 'text-rose-700 dark:text-rose-300' },
};

const ROTULO_CONFIANCA = { alta: 'alta', media: 'média', baixa: 'baixa' } as const;

function useAgora(ativo: boolean): Date {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    if (!ativo) return;
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, [ativo]);
  return agora;
}

/** `execucao_aprovar_plano` exige o artefato; sem ele no cartão, consulta o plano atual. */
async function aprovarPlano(c: CartaoPlanoDto): Promise<unknown> {
  const artefatoId =
    c.plano_artefato_id ??
    (await api('execucao_plano', { params: { id: c.execucao_id } })).atual.artefato_id;
  return api('execucao_aprovar_plano', {
    params: { id: c.execucao_id },
    entrada: { artefato_id: artefatoId },
  });
}

type Dialogo =
  'comentar' | 'descartar' | 'eu_decido' | 'perguntar' | 'aprovar' | 'aprovar_mesmo_assim' | null;

export function CartaoPlano({
  cartao: c,
  invalidar,
  selecionado,
  aoSelecionar,
  aoVerPlano,
}: {
  cartao: CartaoPlanoDto;
  invalidar: unknown[][];
  selecionado: boolean;
  aoSelecionar: ((marcado: boolean) => void) | null;
  aoVerPlano: () => void;
}) {
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [comentario, setComentario] = useState('');
  const classe = classeEfetiva(c);
  const visual = VISUAL_CLASSE[classe];
  const Icone = visual.icone;
  const pendente = cartaoPendente(c);
  const agora = useAgora(classe === 'planejando');
  const plano = c.plano;
  const fechar = (v: boolean) => !v && setDialogo(null);

  const aprovar = useComando({
    executar: () => aprovarPlano(c),
    invalidar,
    sucesso: `#${c.chamado.numero}: plano aprovado`,
    aoSucesso: () => setDialogo(null),
  });
  const comentar = useComando({
    executar: () =>
      api('execucao_comentar_plano', {
        params: { id: c.execucao_id },
        entrada: { texto: comentario.trim() },
      }),
    invalidar,
    sucesso: `#${c.chamado.numero}: comentário enviado; o planejador refaz o plano`,
    aoSucesso: () => {
      setComentario('');
      setDialogo(null);
    },
  });
  const tentarDeNovo = useComando({
    executar: () => api('execucao_tentar_novamente', { params: { id: c.execucao_id } }),
    invalidar,
    sucesso: `#${c.chamado.numero}: planejamento reiniciado`,
  });

  const botaoVerPlano = plano && (
    <Button variant="outline" size="sm" onClick={aoVerPlano}>
      Ver plano
    </Button>
  );
  const botaoComentar = (
    <Button variant="ghost" size="sm" onClick={() => setDialogo('comentar')}>
      Comentar
    </Button>
  );
  const botaoDescartar = (rotulo = 'Descartar') => (
    <Button variant="ghost" size="sm" onClick={() => setDialogo('descartar')}>
      {rotulo}
    </Button>
  );

  return (
    <Card
      className={cn(
        'gap-3 py-4',
        classe === 'alerta_seguranca' && 'border-rose-300 dark:border-rose-900/60',
        classe === 'erro' && 'border-rose-300 dark:border-rose-900/60',
        !pendente && 'opacity-80',
      )}
    >
      <div className="flex items-start gap-3 px-4">
        {aoSelecionar && (
          <Caixa
            marcada={selecionado}
            aoMudar={aoSelecionar}
            rotuloAcessivel={`Selecionar #${c.chamado.numero} para aprovação em bloco`}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            to={`/execucoes/${c.execucao_id}`}
            className="truncate font-medium hover:underline"
            title={c.chamado.titulo}
          >
            <span className="tabular-nums">#{c.chamado.numero}</span> {c.chamado.titulo}
          </Link>
          {plano && classe !== 'planejando' && (
            <p className="text-xs text-muted-foreground">
              confiança {ROTULO_CONFIANCA[plano.confianca]} · {plural(plano.passos.length, 'passo')}{' '}
              · {plural(plano.arquivos_previstos.length, 'arquivo')}
            </p>
          )}
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs font-semibold uppercase',
            visual.classe,
          )}
        >
          <Icone className="size-3.5" aria-hidden />
          {visual.rotulo}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-4 text-sm">
        {classe === 'planejando' && (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            planejando {formatarDecorrido(c.planejando_desde, agora)}
          </p>
        )}

        {classe === 'erro' && (
          <p className="flex items-start gap-1.5 text-rose-700 dark:text-rose-300">
            <OctagonXIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {c.erro ?? 'O planejador falhou.'}
          </p>
        )}

        {classe === 'limpo' && plano?.criterios_de_aceite[0] && (
          <p className="text-muted-foreground">
            {plano.criterios_de_aceite[0].id} {plano.criterios_de_aceite[0].descricao} (
            {plano.criterios_de_aceite[0].verificacao})
          </p>
        )}

        {classe === 'decisao' && plano && (
          <ul className="flex flex-col gap-1.5">
            {plano.perguntas_ao_cliente.map((p, i) => (
              <li key={`p${i}`}>
                <span className="text-muted-foreground">Pergunta ao cliente:</span> “{p.pergunta}”{' '}
                <span className="text-xs text-muted-foreground">
                  suposição: {p.suposicao_padrao}
                </span>
              </li>
            ))}
            {plano.decisoes_do_operador.map((d, i) => (
              <li key={`d${i}`}>
                <span className="text-muted-foreground">Decisão sua:</span> {d.questao}{' '}
                <span className="text-xs text-muted-foreground">
                  recomendação: {d.recomendacao}
                </span>
              </li>
            ))}
          </ul>
        )}

        {classe === 'schema' && plano && (
          <div className="flex flex-col gap-1">
            <SeloBanco altera />
            {plano.schema_banco.mudancas.map((m, i) => (
              <p key={i} className="text-muted-foreground">
                {m.objeto}: {m.descricao} ({m.reversivel ? 'reversível' : 'irreversível'})
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              Só 1 chamado de schema fica em voo por vez
              {c.posicao_schema ? ` · posição ${c.posicao_schema} na espera` : ''}.
            </p>
          </div>
        )}

        {classe === 'alerta_seguranca' && plano && (
          <ul className="flex flex-col gap-1 rounded-md border border-rose-200 bg-rose-50 p-2 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
            {plano.alertas_seguranca.map((a, i) => (
              <li key={i}>“{a}”</li>
            ))}
          </ul>
        )}

        {classe === 'precisa_revisao' && plano && (
          <p className="text-muted-foreground">{plano.justificativa_confianca}</p>
        )}

        {classe !== 'schema' && plano && !plano.schema_banco.altera && classe !== 'planejando' && (
          <SeloBanco altera={false} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4">
        {!pendente ? (
          <>
            <EstadoExecucaoBadge estado={c.estado} />
            <Link
              to={`/execucoes/${c.execucao_id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Abrir
            </Link>
          </>
        ) : classe === 'limpo' ? (
          <>
            {botaoVerPlano}
            {botaoComentar}
            {botaoDescartar()}
          </>
        ) : classe === 'decisao' ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setDialogo('perguntar')}>
              Perguntar ao cliente
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDialogo('eu_decido')}>
              Eu decido
            </Button>
            {botaoDescartar()}
          </>
        ) : classe === 'schema' || classe === 'precisa_revisao' ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setDialogo('aprovar')}>
              Aprovar este plano
            </Button>
            {botaoVerPlano}
            {botaoComentar}
            {botaoDescartar()}
          </>
        ) : classe === 'alerta_seguranca' ? (
          <>
            {botaoVerPlano}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDialogo('aprovar_mesmo_assim')}
            >
              Aprovar mesmo assim…
            </Button>
            {botaoDescartar()}
          </>
        ) : classe === 'erro' ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={tentarDeNovo.isPending}
              onClick={() => tentarDeNovo.mutate(undefined)}
            >
              Tentar de novo
            </Button>
            {botaoDescartar('Descartar do lote')}
          </>
        ) : null}
      </div>

      <DialogoConfirmacao
        aberto={dialogo === 'comentar'}
        aoMudarAberto={fechar}
        titulo={`Comentar o plano do #${c.chamado.numero}`}
        descricao="O planejador refaz o plano com o seu comentário. O cartão volta para “planejando”."
        rotuloConfirmar="Comentar e replanejar"
        bloqueado={comentario.trim().length === 0}
        pendente={comentar.isPending}
        aoConfirmar={() => comentar.mutate(undefined)}
      >
        <Campo rotulo="Comentário">
          {(id) => (
            <Textarea
              id={id}
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              rows={4}
            />
          )}
        </Campo>
      </DialogoConfirmacao>

      <DialogoConfirmacao
        aberto={dialogo === 'aprovar'}
        aoMudarAberto={fechar}
        titulo={`Aprovar o plano do #${c.chamado.numero}?`}
        descricao={
          classe === 'schema'
            ? 'Este plano altera o banco. Só 1 chamado de schema implementa por vez; ele entra na espera do token.'
            : 'A execução segue para a implementação com este plano.'
        }
        rotuloConfirmar="Aprovar este plano"
        pendente={aprovar.isPending}
        aoConfirmar={() => aprovar.mutate(undefined)}
      >
        {plano && <p className="text-muted-foreground">{plano.entendimento}</p>}
      </DialogoConfirmacao>

      <DialogoConfirmacao
        aberto={dialogo === 'aprovar_mesmo_assim'}
        aoMudarAberto={fechar}
        titulo={`Aprovar #${c.chamado.numero} apesar do alerta de segurança?`}
        descricao="O planejador sinalizou que o texto do chamado pede algo perigoso. Aprove só se você leu o plano e o alerta não procede."
        rotuloConfirmar="Aprovar mesmo assim"
        destrutivo
        digitar={{
          esperado: String(c.chamado.numero),
          rotulo: `Digite ${c.chamado.numero} para confirmar`,
        }}
        pendente={aprovar.isPending}
        aoConfirmar={() => aprovar.mutate(undefined)}
      >
        {plano && (
          <ul className="list-disc pl-5 text-rose-700 dark:text-rose-300">
            {plano.alertas_seguranca.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
      </DialogoConfirmacao>

      <DialogoDescartar
        execucaoId={c.execucao_id}
        numero={c.chamado.numero}
        aberto={dialogo === 'descartar'}
        aoMudarAberto={fechar}
        invalidar={invalidar}
      />
      {plano && (
        <>
          <DialogoEuDecido
            execucaoId={c.execucao_id}
            numero={c.chamado.numero}
            perguntas={plano.perguntas_ao_cliente}
            decisoes={plano.decisoes_do_operador}
            aberto={dialogo === 'eu_decido'}
            aoMudarAberto={fechar}
            invalidar={invalidar}
          />
          <DialogoPerguntarCliente
            execucaoId={c.execucao_id}
            numero={c.chamado.numero}
            perguntas={plano.perguntas_ao_cliente}
            aberto={dialogo === 'perguntar'}
            aoMudarAberto={fechar}
            invalidar={invalidar}
          />
        </>
      )}
    </Card>
  );
}
