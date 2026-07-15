import Link from 'next/link';
import { notFound } from 'next/navigation';
import { In } from 'typeorm';
import { ArrowLeft } from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  obterChamado,
  listarMensagens,
  listarEventos,
  listarAnexosDaMensagem,
  listarOperadoresDoTenant,
  listarExecucoesDoChamado,
  buscarSistemaAlvo,
  buscarCategoria,
  UsuarioSchema,
  type Anexo,
  type MensagemTimeline,
  type EventoView,
} from '@chamados/db';
import { Papel, StatusChamado, VisibilidadeMensagem, transicoesDoPapel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import {
  StatusBadge,
  PrioridadeBadge,
  ComplexidadeBadge,
  NaturezaBadge,
  NotaInternaBadge,
} from '@/components/chamado/badges';
import { ROTULO_STATUS_CHAMADO, ROTULO_TIPO_EVENTO, ROTULO_PAPEL, iniciais } from '@/lib/rotulos';
import { dataHora, tempoRelativo } from '@/lib/tempo';
import { RespostaForm } from './resposta-form';
import { PainelPropriedades } from './painel-propriedades';
import { AssistenteIA } from './assistente-ia';

const PROSE_CLS =
  'text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground';

/** Eventos que NÃO viram linha própria (já aparecem como mensagem/descrição). */
const EVENTOS_OCULTOS = new Set<string>([
  'mensagem_publicada',
  'nota_interna_publicada',
  'chamado_criado',
]);

type InfoUsuario = { nome: string; papel: Papel };

type ItemTimeline =
  | { tipo: 'mensagem'; at: number; m: MensagemTimeline; anexos: Anexo[] }
  | { tipo: 'evento'; at: number; e: EventoView };

export default async function ChamadoDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { usuario, tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();

  const dados = await runInTenantContext(ds, tenant.id, async (em) => {
    const chamado = await obterChamado(em, usuario, id);
    if (!chamado || !('operador_id' in chamado)) return null; // equipe vê a forma interna

    const mensagens = await listarMensagens(em, usuario, id);
    const eventos = await listarEventos(em, usuario, id);

    const anexosPorMensagem = new Map<string, Anexo[]>();
    for (const m of mensagens) {
      anexosPorMensagem.set(m.id, await listarAnexosDaMensagem(em, m.id));
    }

    const ids = Array.from(
      new Set(
        [
          chamado.cliente_id,
          chamado.operador_id,
          ...mensagens.map((m) => m.autor_id),
          ...eventos.map((e) => e.ator_id).filter((x): x is string => !!x),
        ].filter((x): x is string => !!x),
      ),
    );
    const usuarios = ids.length ? await em.find(UsuarioSchema, { where: { id: In(ids) } }) : [];
    const nomes: Record<string, InfoUsuario> = {};
    for (const u of usuarios) nomes[u.id] = { nome: u.nome, papel: u.papel };

    const operadores = await listarOperadoresDoTenant(em);
    const execucoesIa = await listarExecucoesDoChamado(em, usuario, id);
    const sistema = chamado.sistema_alvo_id
      ? await buscarSistemaAlvo(em, chamado.sistema_alvo_id)
      : null;
    const categoria = chamado.categoria_id ? await buscarCategoria(em, chamado.categoria_id) : null;

    return {
      chamado,
      mensagens,
      eventos,
      anexosPorMensagem,
      nomes,
      operadores,
      execucoesIa,
      sistemaNome: sistema?.nome ?? null,
      categoriaNome: categoria?.nome ?? null,
    };
  });

  if (!dados) notFound();
  const {
    chamado,
    mensagens,
    eventos,
    anexosPorMensagem,
    nomes,
    operadores,
    execucoesIa,
    sistemaNome,
    categoriaNome,
  } = dados;

  const podeInterna = usuario.papel === Papel.operador || usuario.papel === Papel.admin;
  const encerrado =
    chamado.status === StatusChamado.fechado || chamado.status === StatusChamado.cancelado;
  const alvos = transicoesDoPapel(usuario.papel, chamado.status);
  const nomeAssistente = tenant.config_branding?.agente_ia_nome ?? 'Assistente IA';

  // Timeline unificada (mensagens + eventos relevantes), ordenada por data.
  const itens: ItemTimeline[] = [];
  for (const m of mensagens) {
    itens.push({
      tipo: 'mensagem',
      at: new Date(m.created_at).getTime(),
      m,
      anexos: anexosPorMensagem.get(m.id) ?? [],
    });
  }
  for (const e of eventos) {
    if (EVENTOS_OCULTOS.has(e.tipo)) continue;
    itens.push({ tipo: 'evento', at: new Date(e.created_at).getTime(), e });
  }
  itens.sort((a, b) => a.at - b.at);

  const autorLabel = (autorId: string | null): string => {
    if (!autorId) return 'Sistema';
    return nomes[autorId]?.nome ?? 'Usuário';
  };
  const solicitante = autorLabel(chamado.cliente_id);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <Link
        href="/app/chamados"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Voltar à fila
      </Link>

      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-muted-foreground tabular-nums">
            #{String(chamado.numero)}
          </span>
          <h1 className="font-heading text-xl font-semibold tracking-tight">{chamado.titulo}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={chamado.status} />
          <NaturezaBadge natureza={chamado.natureza} />
          <PrioridadeBadge prioridade={chamado.prioridade} />
          {chamado.complexidade && <ComplexidadeBadge complexidade={chamado.complexidade} />}
        </div>
        <p className="text-xs text-muted-foreground">
          Aberto por {solicitante} · {tempoRelativo(chamado.created_at)} · atualizado{' '}
          {tempoRelativo(chamado.updated_at)}
          {chamado.reaberto_count > 0 && ` · ${chamado.reaberto_count} reabertura(s)`}
        </p>
        <div className={PROSE_CLS} dangerouslySetInnerHTML={{ __html: chamado.descricao_html }} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_336px]">
        {/* Coluna principal: timeline + compositor */}
        <div className="order-2 flex flex-col gap-5 lg:order-1">
          <section className="flex flex-col gap-4">
            <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              Timeline
            </h2>
            {itens.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma atividade ainda.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {itens.map((item) =>
                  item.tipo === 'mensagem' ? (
                    <MensagemBolha
                      key={`m-${item.m.id}`}
                      autor={autorLabel(item.m.autor_id)}
                      papel={nomes[item.m.autor_id]?.papel}
                      interna={
                        'visibilidade' in item.m &&
                        item.m.visibilidade === VisibilidadeMensagem.interna
                      }
                      html={item.m.corpo_html}
                      anexos={item.anexos}
                      quando={item.m.created_at}
                    />
                  ) : (
                    <EventoLinha
                      key={`e-${item.e.id}`}
                      autor={autorLabel(item.e.ator_id)}
                      e={item.e}
                    />
                  ),
                )}
              </div>
            )}
          </section>

          {encerrado ? (
            <div className="rounded-xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
              Chamado {ROTULO_STATUS_CHAMADO[chamado.status].toLowerCase()} — não recebe novas
              mensagens.
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <h2 className="font-heading text-sm font-semibold">Responder</h2>
              <RespostaForm chamadoId={chamado.id} podeInterna={podeInterna} />
            </div>
          )}
        </div>

        {/* Coluna lateral: propriedades + detalhes + IA */}
        <aside className="order-1 flex flex-col gap-4 lg:order-2">
          <div className="rounded-xl border bg-card p-4">
            <PainelPropriedades
              chamadoId={chamado.id}
              status={chamado.status}
              natureza={chamado.natureza}
              prioridade={chamado.prioridade}
              complexidade={chamado.complexidade ?? null}
              alvosStatus={alvos}
              operadores={operadores}
              operadorAtualId={chamado.operador_id ?? null}
              meuId={usuario.id}
              encerrado={encerrado}
            />
          </div>

          <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-sm">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Detalhes
            </h3>
            <LinhaMeta rotulo="Alvo" valor={sistemaNome ?? categoriaNome ?? '—'} />
            <LinhaMeta rotulo="Solicitante" valor={solicitante} />
            <LinhaMeta rotulo="Aberto em" valor={dataHora(chamado.created_at)} />
            <LinhaMeta rotulo="Atualizado" valor={dataHora(chamado.updated_at)} />
            {chamado.resolvido_em && (
              <LinhaMeta rotulo="Resolvido em" valor={dataHora(chamado.resolvido_em)} />
            )}
            <LinhaMeta rotulo="Reaberturas" valor={String(chamado.reaberto_count)} />
          </div>

          <AssistenteIA
            nomeAssistente={nomeAssistente}
            chamadoId={chamado.id}
            execucoes={execucoesIa}
            podeReexecutar={podeInterna}
          />
        </aside>
      </div>
    </div>
  );
}

function LinhaMeta({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{rotulo}</span>
      <span className="text-right font-medium">{valor}</span>
    </div>
  );
}

function MensagemBolha({
  autor,
  papel,
  interna,
  html,
  anexos,
  quando,
}: {
  autor: string;
  papel?: Papel;
  interna: boolean;
  html: string;
  anexos: Anexo[];
  quando: Date | string;
}) {
  return (
    <div
      className={
        'rounded-lg border p-3 ' +
        (interna
          ? 'border-amber-300 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/20'
          : 'bg-card')
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {iniciais(autor)}
        </div>
        <span className="text-sm font-medium">{autor}</span>
        {papel && <span className="text-xs text-muted-foreground">{ROTULO_PAPEL[papel]}</span>}
        {interna && <NotaInternaBadge />}
        <span className="ml-auto text-xs text-muted-foreground" title={dataHora(quando)}>
          {tempoRelativo(quando)}
        </span>
      </div>
      <div className={PROSE_CLS} dangerouslySetInnerHTML={{ __html: html }} />
      {anexos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {anexos.map((a) => (
            <a
              key={a.id}
              href={`/api/anexos/${a.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
            >
              📎 {a.nome_arquivo}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EventoLinha({ autor, e }: { autor: string; e: EventoView }) {
  const dados = e.dados as { de?: string; para?: string; motivo?: string };
  let detalhe = '';
  if (e.tipo === 'status_alterado' && dados.de && dados.para) {
    const de = ROTULO_STATUS_CHAMADO[dados.de as StatusChamado] ?? dados.de;
    const para = ROTULO_STATUS_CHAMADO[dados.para as StatusChamado] ?? dados.para;
    detalhe = ` (${de} → ${para})`;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
      <span className="font-medium">{autor}</span>
      <span>
        {ROTULO_TIPO_EVENTO[e.tipo]}
        {detalhe}
      </span>
      <span className="ml-auto" title={dataHora(e.created_at)}>
        {tempoRelativo(e.created_at)}
      </span>
    </div>
  );
}
