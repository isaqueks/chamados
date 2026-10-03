import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AprovacaoDto, AprovarDto, DiffArquivoDto } from '@comum/dto';
import type { PoliticaStatus } from '@comum/estados';
import { AbaEvidencias } from '@/componentes/aprovacao/aba-evidencias';
import { AbaRelatorio } from '@/componentes/aprovacao/aba-relatorio';
import { AbaResposta, useValidacaoResposta } from '@/componentes/aprovacao/aba-resposta';
import { AbaTecnico } from '@/componentes/aprovacao/aba-tecnico';
import { AlertasAprovacao } from '@/componentes/aprovacao/alertas-aprovacao';
import { BarraAprovacao, DialogoPedirAjustes } from '@/componentes/aprovacao/barra-aprovacao';
import { CabecalhoAprovacao } from '@/componentes/aprovacao/cabecalho-aprovacao';
import {
  avisosDoBotao,
  ordenarArquivosDiff,
  proximoIndice,
} from '@/componentes/aprovacao/regras-aprovar';
import { VisorDiff, type ModoVisao } from '@/componentes/aprovacao/visor-diff';
import { acoesAprovacao } from '@/componentes/execucao/acoes-execucao';
import { exigeRecarregarAprovacao } from '@/componentes/execucao/arvore-feed';
import { DialogoAssumir, DialogoDescartar } from '@/componentes/execucao/dialogos-execucao';
import { textoCiclos } from '@/componentes/execucao/formato-execucao';
import { CarregandoTela, ErroTela, Faixa, Tecla } from '@/componentes/execucao/suporte';
import { useComando } from '@/componentes/apoio/comando';
import { useAtalhos } from '@/componentes/fila/atalhos-teclado';
import { api, urlRota } from '@/lib/api';
import { ROTULO_ESTADO_EXECUCAO } from '@/lib/rotulos';
import { assinarSse } from '@/lib/sse';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';

/**
 * Aprovação (G2) — specs/forja/06 §4.3, "a tela mais importante do produto":
 * "posso mandar isto para a branch de destino e responder ao cliente?".
 *
 * FJ-034 (2026-10-03, "dois cliques"): o relatório é a primeira aba e tudo
 * continua à mão (diff, evidências, resposta, técnico), mas nada é
 * pré-requisito — "Aprovar e mergear" aprova num clique, com os avisos
 * empilhados acima do botão. O "visto" por arquivo e as abas abertas são só
 * conveniência desta VERSÃO e deste PATCH (`sessionStorage`, chave
 * `execução:versão:patch-id`). O servidor confere de novo `patch_id`, `sha` e
 * a última mensagem nova do cliente mostrada (dado velho → 409, recarrega).
 *
 * Atalhos (06 §9): `1`…`6` abas, `a` leva o foco ao botão Aprovar e mergear
 * (Enter aprova; uma tecla sozinha nunca aprova), `r` pedir ajustes, `t`
 * assumir, `n`/`p`/`v` no Diff, `?` ajuda. Descartar não tem atalho. Cada ação (botão e atalho) só existe se
 * `ExecucaoDto.acoes` a oferece; fora de `aguardando_aprovacao` a tela fica em
 * modo leitura, com link para a Execução.
 *
 * Ao vivo: o SSE da execução recarrega a aprovação em estado novo, commit
 * (patch novo ⇒ revisão zerada), fim de etapa e mensagem nova do cliente; um
 * refetch a cada minuto recalcula "Conflita com destino" quando a ponta muda.
 * Aprovar recusado por dado velho (409/422) também recarrega.
 */

type Aba = 'relatorio' | 'diff' | 'interdiff' | 'evidencias' | 'resposta' | 'tecnico';
const ORDEM_ABAS: Aba[] = ['relatorio', 'diff', 'interdiff', 'evidencias', 'resposta', 'tecnico'];

interface RevisaoSalva {
  diffAberto: boolean;
  interdiffAberto: boolean;
  evidenciasAbertas: boolean;
  /** "Visto" na aba Diff — o único que conta para os arquivos de selo. */
  vistos: string[];
  vistosInterdiff?: string[];
}

function chaveRevisao(a: AprovacaoDto): string {
  return `forja:revisao:${a.execucao_id}:v${a.versao}:${a.patch_id}`;
}

function lerRevisao(chave: string): RevisaoSalva | null {
  try {
    const bruto = window.sessionStorage.getItem(chave);
    return bruto ? (JSON.parse(bruto) as RevisaoSalva) : null;
  } catch {
    return null;
  }
}

function gravarRevisao(chave: string, r: RevisaoSalva): void {
  try {
    window.sessionStorage.setItem(chave, JSON.stringify(r));
  } catch {
    // conveniência: sem storage, a revisão vale só enquanto a tela está aberta
  }
}

export function TelaAprovacao() {
  const { id = '' } = useParams();
  const clienteQuery = useQueryClient();
  const aprovacao = useQuery({
    queryKey: ['aprovacao', id],
    queryFn: ({ signal }) => api('aprovacao_obter', { params: { id }, sinal: signal }),
    enabled: !!id,
    // "Conflita com destino" depende da ponta do destino, que muda sem evento desta execução.
    refetchInterval: 60_000,
  });

  const recarga = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!id) return;
    const recarregar = () => {
      if (recarga.current) return;
      recarga.current = setTimeout(() => {
        recarga.current = null;
        for (const chave of ['aprovacao', 'execucao', 'diff', 'interdiff', 'tecnico']) {
          void clienteQuery.invalidateQueries({ queryKey: [chave, id] });
        }
      }, 300);
    };
    const assinatura = assinarSse({
      caminho: urlRota('execucao_eventos', { id }),
      aoEvento: (e) => {
        if (exigeRecarregarAprovacao(e)) recarregar();
      },
      aoRecarregar: recarregar,
    });
    return () => {
      assinatura.fechar();
      if (recarga.current) clearTimeout(recarga.current);
      recarga.current = null;
    };
  }, [id, clienteQuery]);

  if (aprovacao.isLoading) return <CarregandoTela />;
  if (aprovacao.error || !aprovacao.data) {
    return <ErroTela erro={aprovacao.error} titulo="Não foi possível abrir a aprovação" />;
  }
  // `key` zera todo o estado local quando a versão ou o patch mudam (F-11).
  return <Aprovacao key={chaveRevisao(aprovacao.data)} aprovacao={aprovacao.data} />;
}

function Aprovacao({ aprovacao: a }: { aprovacao: AprovacaoDto }) {
  const id = a.execucao_id;
  const chave = chaveRevisao(a);
  const salva = useMemo(() => lerRevisao(chave), [chave]);

  const [aba, setAba] = useState<Aba>('relatorio');
  const [diffAberto, setDiffAberto] = useState(salva?.diffAberto ?? false);
  const [interdiffAberto, setInterdiffAberto] = useState(salva?.interdiffAberto ?? false);
  const [evidenciasAbertas, setEvidenciasAbertas] = useState(salva?.evidenciasAbertas ?? false);
  const [vistos, setVistos] = useState<Set<string>>(() => new Set(salva?.vistos ?? []));
  const [vistosInterdiff, setVistosInterdiff] = useState<Set<string>>(
    () => new Set(salva?.vistosInterdiff ?? []),
  );
  const botaoAprovar = useRef<HTMLButtonElement>(null);
  const [texto, setTexto] = useState(a.resposta.corpo_markdown);
  const [publicarMesmoAssim, setPublicarMesmoAssim] = useState(false);
  const [politica, setPolitica] = useState<PoliticaStatus>(a.politica_padrao);
  const [indiceDiff, setIndiceDiff] = useState(0);
  const [indiceInterdiff, setIndiceInterdiff] = useState(0);
  const [modoDiff, setModoDiff] = useState<ModoVisao>('split');
  const [somenteSensiveis, setSomenteSensiveis] = useState(false);
  const [dialogo, setDialogo] = useState<'ajustes' | 'assumir' | 'descartar' | 'ajuda' | null>(
    null,
  );

  useEffect(() => {
    gravarRevisao(chave, {
      diffAberto,
      interdiffAberto,
      evidenciasAbertas,
      vistos: [...vistos],
      vistosInterdiff: [...vistosInterdiff],
    });
  }, [chave, diffAberto, interdiffAberto, evidenciasAbertas, vistos, vistosInterdiff]);

  const temInterdiff = a.versao > 1 || a.reaprovacao !== null;
  const temEvidencias = a.relatorio.selos.altera_ui || a.relatorio.alteracoes_de_interface.houve;

  const diff = useQuery({
    queryKey: ['diff', id, a.versao],
    queryFn: ({ signal }) =>
      api('aprovacao_diff', { params: { id }, entrada: { versao: a.versao }, sinal: signal }),
  });
  const interdiff = useQuery({
    queryKey: ['interdiff', id, a.versao],
    queryFn: ({ signal }) => api('aprovacao_interdiff', { params: { id }, sinal: signal }),
    enabled: temInterdiff && aba === 'interdiff',
  });
  const evidencias = useQuery({
    queryKey: ['evidencias', id, a.versao],
    queryFn: ({ signal }) => api('aprovacao_evidencias', { params: { id }, sinal: signal }),
    enabled: temEvidencias && aba === 'evidencias',
  });
  const tecnico = useQuery({
    queryKey: ['tecnico', id, a.versao],
    queryFn: ({ signal }) => api('aprovacao_tecnico', { params: { id }, sinal: signal }),
  });
  const execucao = useQuery({
    queryKey: ['execucao', id],
    queryFn: ({ signal }) => api('execucao_obter', { params: { id }, sinal: signal }),
  });
  const acoes = acoesAprovacao(execucao.data);

  // Aba aberta só conta quando o conteúdo carregou: abrir sobre um erro não é "ver".
  useEffect(() => {
    if (aba === 'diff' && diff.isSuccess) setDiffAberto(true);
    if (aba === 'interdiff' && interdiff.isSuccess) setInterdiffAberto(true);
    if (aba === 'evidencias' && evidencias.isSuccess) setEvidenciasAbertas(true);
  }, [aba, diff.isSuccess, interdiff.isSuccess, evidencias.isSuccess]);

  const { validacao, doServidor } = useValidacaoResposta(id, texto, a.resposta.tipo);

  const recapturar = useComando({
    executar: () => api('execucao_recapturar_prints', { params: { id } }),
    sucesso: 'Recapturando os prints no mesmo sha.',
    invalidar: [
      ['evidencias', id],
      ['aprovacao', id],
    ],
  });

  const arquivosDiff = useMemo(() => ordenarArquivosDiff(diff.data?.arquivos ?? []), [diff.data]);
  const arquivosVisiveis = useMemo(
    () =>
      somenteSensiveis ? arquivosDiff.filter((f) => f.selos.includes('sensivel')) : arquivosDiff,
    [arquivosDiff, somenteSensiveis],
  );
  const arquivosInterdiff = useMemo(
    () => ordenarArquivosDiff(interdiff.data?.arquivos ?? []),
    [interdiff.data],
  );

  const avisos = avisosDoBotao(a, { violada: !validacao.ok, publicarMesmoAssim });
  const arquivosSelo = useMemo(
    () => arquivosDiff.filter((f) => f.selos.length > 0).map((f) => f.caminho),
    [arquivosDiff],
  );

  const entradaAprovar: AprovarDto = {
    relatorio_artefato_id: a.relatorio_artefato_id,
    patch_id: a.patch_id,
    sha: a.sha,
    texto_resposta: texto,
    politica_status: politica,
    publicar_mesmo_assim: !validacao.ok && publicarMesmoAssim,
    // A última mensagem nova que a tela mostra (FJ-034: sem checkbox).
    ciente_mensagem_id: a.mensagens_novas_cliente.at(-1)?.id ?? null,
  };

  function alternarEm(setter: typeof setVistos, caminho: string, visto: boolean): void {
    setter((atual) => {
      const novo = new Set(atual);
      if (visto) novo.add(caminho);
      else novo.delete(caminho);
      return novo;
    });
  }
  const marcarVisto = (caminho: string, visto: boolean) => alternarEm(setVistos, caminho, visto);
  const marcarVistoInterdiff = (caminho: string, visto: boolean) =>
    alternarEm(setVistosInterdiff, caminho, visto);

  function navegarArquivo(direcao: 1 | -1): void {
    if (aba === 'diff') setIndiceDiff((i) => proximoIndice(i, arquivosVisiveis.length, direcao));
    if (aba === 'interdiff')
      setIndiceInterdiff((i) => proximoIndice(i, arquivosInterdiff.length, direcao));
  }

  function arquivoAtual(): DiffArquivoDto | undefined {
    if (aba === 'diff') return arquivosVisiveis[indiceDiff];
    if (aba === 'interdiff') return arquivosInterdiff[indiceInterdiff];
    return undefined;
  }

  const mapaAtalhos: Record<string, () => void> = {
    // Foco no botão (Enter aprova): uma tecla sozinha nunca faz merge.
    a: () => acoes.aprovar && botaoAprovar.current?.focus(),
    r: () => acoes.pedirAjustes && setDialogo('ajustes'),
    t: () => acoes.assumir && setDialogo('assumir'),
    n: () => navegarArquivo(1),
    p: () => navegarArquivo(-1),
    v: () => {
      const f = arquivoAtual();
      if (!f) return;
      if (aba === 'interdiff') marcarVistoInterdiff(f.caminho, !vistosInterdiff.has(f.caminho));
      else marcarVisto(f.caminho, !vistos.has(f.caminho));
    },
    '?': () => setDialogo('ajuda'),
  };
  ORDEM_ABAS.forEach((x, i) => {
    mapaAtalhos[String(i + 1)] = () => {
      if (x === 'interdiff' && !temInterdiff) return;
      if (x === 'evidencias' && !temEvidencias) return;
      setAba(x);
    };
  });
  useAtalhos(mapaAtalhos);

  const nArquivos = diff.data?.arquivos.length;
  const etapaAtual = execucao.data?.etapas[execucao.data.etapas.length - 1];

  return (
    <div className="flex min-h-full flex-col">
      <CabecalhoAprovacao
        aprovacao={a}
        aoAbrirEvidencias={() => temEvidencias && setAba('evidencias')}
        aoFiltrarSensiveis={() => {
          setSomenteSensiveis(true);
          setIndiceDiff(0);
          setAba('diff');
        }}
      />
      <div className="flex flex-1 flex-col gap-4 p-6">
        {!acoes.aguardando && execucao.data && (
          <Faixa
            tom="info"
            titulo={`Esta versão não está aguardando aprovação (${ROTULO_ESTADO_EXECUCAO[execucao.data.estado].toLowerCase()})`}
            acoes={
              <Button size="sm" variant="outline" render={<Link to={`/execucoes/${id}`} />}>
                Abrir a Execução
              </Button>
            }
          >
            O relatório e o diff ficam para leitura; as ações válidas agora estão na Execução.
          </Faixa>
        )}
        <AlertasAprovacao
          aprovacao={a}
          podeRecapturar={acoes.recapturar}
          aoRecapturar={() => recapturar.mutate(undefined)}
          recapturando={recapturar.isPending}
        />

        <Tabs value={aba} onValueChange={(v) => setAba(v as Aba)}>
          <TabsList variant="line" className="h-auto flex-wrap">
            <TabsTrigger value="relatorio">Relatório</TabsTrigger>
            <TabsTrigger value="diff">
              Diff{nArquivos !== undefined && ` (${nArquivos})`}
            </TabsTrigger>
            {temInterdiff && (
              <TabsTrigger value="interdiff">
                Interdiff v{a.versao - 1}→v{a.versao}
              </TabsTrigger>
            )}
            {temEvidencias && <TabsTrigger value="evidencias">Evidências</TabsTrigger>}
            <TabsTrigger value="resposta">
              Resposta ao cliente
              {!validacao.ok && (
                <span className="text-rose-700 dark:text-rose-300" aria-label="com violações">
                  !
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="tecnico">Técnico</TabsTrigger>
          </TabsList>

          <TabsContent value="relatorio" className="pt-3">
            <AbaRelatorio
              relatorio={a.relatorio}
              versao={a.versao}
              tecnico={tecnico.data}
              aoAbrirEvidencias={() => temEvidencias && setAba('evidencias')}
            />
          </TabsContent>

          <TabsContent value="diff" className="pt-3">
            {diff.error ? (
              <ErroTela
                erro={diff.error}
                titulo="Não foi possível carregar o diff"
                tentarDeNovo={() => void diff.refetch()}
              />
            ) : !diff.data ? (
              <Skeleton className="h-96 w-full" />
            ) : (
              <VisorDiff
                diff={diff.data}
                arquivos={arquivosVisiveis}
                indice={Math.min(indiceDiff, Math.max(0, arquivosVisiveis.length - 1))}
                aoMudarIndice={setIndiceDiff}
                vistos={vistos}
                aoMarcarVisto={marcarVisto}
                arquivosSelo={arquivosSelo}
                modo={modoDiff}
                aoMudarModo={setModoDiff}
                somenteSensiveis={somenteSensiveis}
                aoAlternarSensiveis={() => {
                  setSomenteSensiveis((v) => !v);
                  setIndiceDiff(0);
                }}
              />
            )}
          </TabsContent>

          {temInterdiff && (
            <TabsContent value="interdiff" className="pt-3">
              <p className="mb-3 text-sm text-muted-foreground">
                Diff bruto entre o sha apresentado na versão {a.versao - 1} e o atual (o interdiff
                legível fica para a Fase 2).
              </p>
              {interdiff.error ? (
                <ErroTela
                  erro={interdiff.error}
                  titulo="Não foi possível carregar o interdiff"
                  tentarDeNovo={() => void interdiff.refetch()}
                />
              ) : !interdiff.data ? (
                <Skeleton className="h-96 w-full" />
              ) : (
                <VisorDiff
                  diff={interdiff.data}
                  arquivos={arquivosInterdiff}
                  indice={Math.min(indiceInterdiff, Math.max(0, arquivosInterdiff.length - 1))}
                  aoMudarIndice={setIndiceInterdiff}
                  vistos={vistosInterdiff}
                  aoMarcarVisto={marcarVistoInterdiff}
                  arquivosSelo={[]}
                  modo={modoDiff}
                  aoMudarModo={setModoDiff}
                  somenteSensiveis={false}
                  aoAlternarSensiveis={() => undefined}
                />
              )}
            </TabsContent>
          )}

          {temEvidencias && (
            <TabsContent value="evidencias" className="pt-3">
              {evidencias.error ? (
                <ErroTela
                  erro={evidencias.error}
                  titulo="Não foi possível carregar as evidências"
                />
              ) : !evidencias.data ? (
                <Skeleton className="h-96 w-full" />
              ) : (
                <AbaEvidencias
                  evidencias={evidencias.data}
                  aoRecapturar={acoes.recapturar ? () => recapturar.mutate(undefined) : undefined}
                />
              )}
            </TabsContent>
          )}

          <TabsContent value="resposta" className="pt-3">
            <AbaResposta
              texto={texto}
              aoMudarTexto={(t) => {
                setTexto(t);
                setPublicarMesmoAssim(false);
              }}
              original={a.resposta}
              autor={a.autor_publico}
              validacao={validacao}
              doServidor={doServidor}
              publicarMesmoAssim={publicarMesmoAssim}
              aoMudarPublicarMesmoAssim={setPublicarMesmoAssim}
            />
          </TabsContent>

          <TabsContent value="tecnico" className="pt-3">
            {tecnico.error ? (
              <ErroTela erro={tecnico.error} titulo="Não foi possível carregar os dados técnicos" />
            ) : !tecnico.data ? (
              <Skeleton className="h-96 w-full" />
            ) : (
              <AbaTecnico tecnico={tecnico.data} />
            )}
          </TabsContent>
        </Tabs>
      </div>

      <BarraAprovacao
        aprovacao={a}
        politica={politica}
        aoMudarPolitica={setPolitica}
        avisos={avisos}
        acoes={acoes}
        entrada={entradaAprovar}
        botaoAprovarRef={botaoAprovar}
        aoPedirAjustes={() => setDialogo('ajustes')}
        aoAssumir={() => setDialogo('assumir')}
        aoDescartar={() => setDialogo('descartar')}
      />

      <DialogoPedirAjustes
        execucaoId={id}
        aberto={dialogo === 'ajustes'}
        aoFechar={() => setDialogo(null)}
        arquivos={arquivosDiff.map((f) => f.caminho)}
        tetoCiclos={
          execucao.data
            ? textoCiclos(
                execucao.data.ciclo_auto,
                execucao.data.ciclo_total + 1,
                execucao.data.limites_ciclo,
              )
            : null
        }
      />
      <DialogoAssumir
        execucaoId={id}
        sessaoId={etapaAtual?.session_id ?? null}
        aberto={dialogo === 'assumir'}
        aoFechar={() => setDialogo(null)}
        invalidaAprovacao
      />
      <DialogoDescartar
        execucaoId={id}
        numero={a.chamado.numero}
        aberto={dialogo === 'descartar'}
        aoFechar={() => setDialogo(null)}
      />
      <AjudaAtalhos aberto={dialogo === 'ajuda'} aoFechar={() => setDialogo(null)} />
    </div>
  );
}

const ATALHOS_APROVACAO: [string, string][] = [
  ['1 … 6', 'abas'],
  ['n / p', 'próximo / anterior arquivo (Diff)'],
  ['v', 'marcar arquivo como visto'],
  ['a', 'foco em Aprovar e mergear (Enter aprova)'],
  ['r', 'Pedir ajustes'],
  ['t', 'Assumir'],
  ['Ctrl+Enter / Esc', 'confirmar / cancelar nos diálogos'],
];

function AjudaAtalhos({ aberto, aoFechar }: { aberto: boolean; aoFechar: () => void }) {
  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Atalhos da Aprovação</DialogTitle>
          <DialogDescription>
            Desligados com o foco num campo de texto. Descartar não tem atalho.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {ATALHOS_APROVACAO.map(([tecla, acao]) => (
            <div key={tecla} className="contents">
              <dt>
                <Tecla>{tecla}</Tecla>
              </dt>
              <dd>{acao}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
