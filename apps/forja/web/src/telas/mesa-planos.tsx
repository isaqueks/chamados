import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileStackIcon, InfoIcon } from 'lucide-react';
import type { CartaoPlanoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/ui/button';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Faixa,
  Pagina,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { plural } from '@/componentes/apoio/texto';
import { CartaoPlano } from '@/componentes/lote/cartao-plano';
import {
  alternar,
  contarFiltros,
  filtrarEOrdenar,
  limposSelecionaveis,
  reconciliarSelecao,
  resumoLinhaPlano,
  ROTULO_FILTRO_MESA,
  type FiltroMesa,
} from '@/componentes/lote/logica';
import { SheetPlano } from '@/componentes/lote/plano-legivel';

/**
 * Mesa de planos (specs/forja/06 §4.4, fluxo §5.2; gate G1 em bloco, F-11).
 *
 * Os cartões aparecem conforme os planos ficam prontos e o usuário age antes
 * de o lote terminar de planejar. A única ação primária é **Aprovar limpos
 * (N)…** (06 §6 item 8), que abre um diálogo listando cada chamado com o
 * resumo de uma linha — nunca "aprovar tudo" às cegas. Schema, alerta de
 * segurança e decisão são sempre individuais.
 *
 * Atualização: polling curto enquanto há planejador rodando (o stream global
 * é do shell; uma segunda conexão SSE por tela disputaria o limite de
 * conexões do navegador por origem).
 */

const FILTROS: FiltroMesa[] = ['todos', 'limpos', 'precisam', 'planejando'];

export function TelaMesaPlanos() {
  const { id = '' } = useParams();
  const chave = ['lote', id, 'planos'];
  const [filtro, setFiltro] = useState<FiltroMesa>('todos');
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const conhecidos = useRef<Set<string>>(new Set());
  const [confirmarLimpos, setConfirmarLimpos] = useState(false);
  const [planoAberto, setPlanoAberto] = useState<CartaoPlanoDto | null>(null);

  const consulta = useQuery({
    queryKey: chave,
    queryFn: ({ signal }) => api('lote_planos', { params: { id }, sinal: signal }),
    refetchInterval: (q) => ((q.state.data?.planejando ?? 0) > 0 ? 4_000 : 15_000),
  });
  const mesa = consulta.data;
  const cartoes = useMemo(() => mesa?.cartoes ?? [], [mesa]);

  // Limpos novos entram marcados; os que deixaram de ser selecionáveis saem.
  useEffect(() => {
    setSelecao((atual) => reconciliarSelecao(atual, conhecidos.current, cartoes));
    for (const c of limposSelecionaveis(cartoes)) conhecidos.current.add(c.execucao_id);
  }, [cartoes]);

  const contagem = contarFiltros(cartoes);
  const visiveis = filtrarEOrdenar(cartoes, filtro);
  const selecionados = limposSelecionaveis(cartoes).filter((c) => selecao.has(c.execucao_id));

  const aprovarLimpos = useComando({
    executar: () =>
      api('lote_aprovar_limpos', {
        params: { id },
        entrada: { execucao_ids: selecionados.map((c) => c.execucao_id) },
      }),
    invalidar: [chave, ['lote', id], ['lotes']],
    sucesso: () => `${plural(selecionados.length, 'plano aprovado', 'planos aprovados')}`,
    aoSucesso: () => setConfirmarLimpos(false),
  });

  if (consulta.isPending) {
    return (
      <Pagina largura="larga">
        <CabecalhoPagina titulo="Mesa de planos" />
        <Carregando linhas={6} />
      </Pagina>
    );
  }
  if (consulta.isError || !mesa) {
    return (
      <Pagina largura="larga">
        <CabecalhoPagina titulo="Mesa de planos" voltar={{ href: '/lotes', rotulo: 'Lotes' }} />
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      </Pagina>
    );
  }

  return (
    <Pagina largura="larga">
      <CabecalhoPagina
        voltar={{ href: '/lotes', rotulo: 'Lotes' }}
        titulo={`${mesa.nome} · Mesa de planos`}
        descricao={`${plural(mesa.total, 'chamado')}: ${mesa.prontos} ${mesa.prontos === 1 ? 'pronto' : 'prontos'}, ${mesa.planejando} planejando · concorrência de planos ${mesa.concorrencia_planos}`}
        acoes={
          <>
            <Link
              to={`/lotes/${id}`}
              className={buttonVariants({ variant: 'outline', size: 'default' })}
            >
              Acompanhar lote
            </Link>
            <Button disabled={selecionados.length === 0} onClick={() => setConfirmarLimpos(true)}>
              Aprovar limpos ({selecionados.length})…
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar cartões">
        {FILTROS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filtro === f ? 'secondary' : 'ghost'}
            aria-pressed={filtro === f}
            onClick={() => setFiltro(f)}
            className={cn(filtro === f && 'font-semibold')}
          >
            {ROTULO_FILTRO_MESA[f]} ({contagem[f]})
          </Button>
        ))}
      </div>

      {cartoes.length === 0 ? (
        <Vazio
          icone={FileStackIcon}
          titulo="Nenhum plano pronto ainda."
          descricao="Os planejadores estão lendo os chamados; os planos aparecem aqui conforme ficam prontos."
        />
      ) : visiveis.length === 0 ? (
        <Vazio
          icone={FileStackIcon}
          titulo={`Nada em “${ROTULO_FILTRO_MESA[filtro]}”.`}
          acao={
            <Button variant="outline" size="sm" onClick={() => setFiltro('todos')}>
              Ver todos
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visiveis.map((c) => {
            const selecionavel = limposSelecionaveis([c]).length === 1;
            return (
              <CartaoPlano
                key={c.execucao_id}
                cartao={c}
                invalidar={[chave, ['lote', id]]}
                selecionado={selecao.has(c.execucao_id)}
                aoSelecionar={
                  selecionavel
                    ? (marcado) =>
                        setSelecao((s) =>
                          marcado === s.has(c.execucao_id) ? s : alternar(s, c.execucao_id),
                        )
                    : null
                }
                aoVerPlano={() => setPlanoAberto(c)}
              />
            );
          })}
        </div>
      )}

      {mesa.arquivos_em_comum.length > 0 && (
        <Faixa nivel="info" icone={InfoIcon}>
          <span className="font-medium">Arquivos em comum</span> (informativo; a ordem é sua):{' '}
          {mesa.arquivos_em_comum
            .map((a) => `${a.numeros.map((n) => `#${n}`).join(' e ')} tocam ${a.arquivo}`)
            .join(' · ')}
        </Faixa>
      )}

      <DialogoConfirmacao
        aberto={confirmarLimpos}
        aoMudarAberto={setConfirmarLimpos}
        titulo={`Aprovar ${plural(selecionados.length, 'plano limpo', 'planos limpos')}?`}
        descricao="Cada um segue para a implementação com o plano abaixo. Planos com schema, decisão ou alerta não entram aqui."
        rotuloConfirmar={`Aprovar ${selecionados.length}`}
        bloqueado={selecionados.length === 0}
        pendente={aprovarLimpos.isPending}
        aoConfirmar={() => aprovarLimpos.mutate(undefined)}
        largo
      >
        <ul className="flex flex-col divide-y rounded-lg border">
          {selecionados.map((c) => (
            <li key={c.execucao_id} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="font-medium">
                #{c.chamado.numero} {c.chamado.titulo}
              </span>
              <span className="text-xs text-muted-foreground">{resumoLinhaPlano(c)}</span>
            </li>
          ))}
        </ul>
      </DialogoConfirmacao>

      <SheetPlano
        plano={planoAberto?.plano ?? null}
        titulo={planoAberto ? `#${planoAberto.chamado.numero} ${planoAberto.chamado.titulo}` : ''}
        aberto={planoAberto !== null}
        aoMudarAberto={(v) => !v && setPlanoAberto(null)}
      />
    </Pagina>
  );
}
