import Link from 'next/link';
import { notFound } from 'next/navigation';
import { In } from 'typeorm';
import {
  ArrowLeft,
  Bot,
  CircleUser,
  Eye,
  MessageSquare,
  Plus,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  obterChamado,
  listarMensagens,
  listarEventos,
  listarAnexosDaMensagem,
  UsuarioSchema,
  type Anexo,
  type MensagemTimeline,
  type EventoView,
} from '@chamados/db';
import {
  Papel,
  StatusChamado,
  transicoesDoPapel,
  formatarPrazoAprovacao,
  formatarBrl,
  detalheEventoCusto,
  type TipoEvento,
} from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { ROTULO_STATUS_CHAMADO, ROTULO_TIPO_EVENTO, iniciais } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { classesConteudoRico } from '@/components/editor';
import {
  StatusBadge,
  NaturezaBadge,
  PrioridadeBadge,
  EstimativaCustoBadge,
  CustoFinalBadge,
} from '@/components/portal/chamado-badges';
import { tempoRelativo, dataHoraAbsoluta } from '@/components/portal/tempo';
import { acaoTransicionarCliente } from '../actions';
import { RespostaForm } from './resposta-form';
import { DialogoCancelar } from './dialogo-cancelar';
import { AprovacaoCliente } from './aprovacao-cliente';
import { ToastAoMontar } from './toast-ao-montar';
import { AtualizacaoPeriodica } from '@/components/chamado/atualizacao-periodica';

/** Eventos já representados como mensagem na timeline (não viram linha própria). */
const EVENTOS_OCULTOS = new Set<TipoEvento>(['mensagem_publicada', 'nota_interna_publicada']);

/**
 * `solicitante`: outro cliente do tenant — só aparece quando o usuário acompanha
 * um chamado ALHEIO (D-037), cujo autor das mensagens públicas é o solicitante.
 */
type TipoAutor = 'voce' | 'solicitante' | 'equipe' | 'ia' | 'sistema';
type InfoUsuario = { nome: string; papel: Papel };

type ItemTimeline =
  | { tipo: 'mensagem'; at: number; m: MensagemTimeline; anexos: Anexo[] }
  | { tipo: 'evento'; at: number; e: EventoView };

export default async function ChamadoDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aberto?: string }>;
}) {
  const { id } = await params;
  const { aberto } = await searchParams;
  const { usuario, tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();

  const dados = await runInTenantContext(ds, tenant.id, async (em) => {
    const chamado = await obterChamado(em, usuario, id);
    if (!chamado) return null;
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
          ...mensagens.map((m) => m.autor_id),
          ...eventos.map((e) => e.ator_id).filter((x): x is string => !!x),
        ].filter(Boolean),
      ),
    );
    const usuarios = ids.length ? await em.find(UsuarioSchema, { where: { id: In(ids) } }) : [];
    const nomes: Record<string, InfoUsuario> = {};
    for (const u of usuarios) nomes[u.id] = { nome: u.nome, papel: u.papel };

    return { chamado, mensagens, eventos, anexosPorMensagem, nomes };
  });

  if (!dados) notFound();
  const { chamado, mensagens, eventos, anexosPorMensagem, nomes } = dados;

  const agenteNome = tenant.config_branding?.agente_ia_nome?.trim() || 'Assistente';
  const encerrado =
    chamado.status === StatusChamado.fechado || chamado.status === StatusChamado.cancelado;
  const aguardando = chamado.status === StatusChamado.aguardando_cliente;
  const resolvido = chamado.status === StatusChamado.resolvido;

  // LER × AGIR (D-037): o cliente lê qualquer chamado do tenant, mas só age
  // (responder, reabrir, cancelar) nos que solicitou. Num chamado alheio a tela
  // é somente leitura — a UI esconde, e o servidor recusa de qualquer forma.
  const meu = chamado.cliente_id === usuario.id;
  const solicitanteNome = nomes[chamado.cliente_id]?.nome ?? 'outro usuário';

  const alvos = meu ? transicoesDoPapel(Papel.cliente, chamado.status) : [];
  // Em `resolvido` o "reabrir" vira CONTESTAR (com motivo) — D-042; o Reabrir de
  // um clique fica só para fechado/cancelado (D-038).
  const podeReabrir = !resolvido && alvos.includes(StatusChamado.em_atendimento);
  const podeCancelar = alvos.includes(StatusChamado.cancelado);
  // Janela de aprovação (D-042): só o solicitante aprova/contesta.
  const aguardandoAprovacao = resolvido && meu;
  const prazoAprovacao = chamado.fechar_automaticamente_em
    ? formatarPrazoAprovacao(chamado.fechar_automaticamente_em)
    : null;

  function tipoAutor(autorId: string | null): TipoAutor {
    if (!autorId) return 'sistema';
    if (autorId === usuario.id) return 'voce';
    const papel = nomes[autorId]?.papel;
    if (papel === Papel.agente_ia) return 'ia';
    if (papel === Papel.cliente) return 'solicitante';
    return 'equipe';
  }
  function nomeAutor(autorId: string | null, tipo: TipoAutor): string {
    if (tipo === 'voce') return 'Você';
    if (tipo === 'ia') return agenteNome;
    if (tipo === 'sistema') return 'Sistema';
    if (tipo === 'solicitante') return (autorId && nomes[autorId]?.nome) || 'Solicitante';
    return (autorId && nomes[autorId]?.nome) || 'Suporte';
  }

  // Timeline unificada (mensagens públicas + eventos visíveis), ordenada por data.
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

  return (
    <div className="flex flex-col gap-5">
      {/* Novas respostas/eventos aparecem sozinhos (short-polling de 1 min). */}
      <AtualizacaoPeriodica />
      {aberto === '1' && (
        <ToastAoMontar
          texto="Chamado aberto! Nossa equipe já vai analisar."
          limparHref={`/portal/chamados/${chamado.id}`}
        />
      )}

      <Link
        href="/portal"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Chamados
      </Link>

      {/* Cabeçalho — número integrado à linha do título (nunca órfão). */}
      <div className="flex flex-col gap-2.5">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
          <span className="mr-2 font-normal text-muted-foreground">#{String(chamado.numero)}</span>
          {chamado.titulo}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={chamado.status} />
          <PrioridadeBadge prioridade={chamado.prioridade} />
          <NaturezaBadge natureza={chamado.natureza} />
          {/* D-043: estimativa e custo final definidos pela equipe. */}
          {chamado.estimativa_custo && (
            <EstimativaCustoBadge estimativa={chamado.estimativa_custo} />
          )}
          {chamado.custo_final != null && <CustoFinalBadge valor={chamado.custo_final} />}
        </div>
        <p className="text-xs text-muted-foreground">
          {meu ? 'Aberto' : `Aberto por ${solicitanteNome}`} {tempoRelativo(chamado.created_at)} ·
          atualizado {tempoRelativo(chamado.updated_at)}
        </p>
      </div>

      {/* Banner: aguardando resposta do cliente (só para o solicitante) */}
      {aguardando && meu && (
        <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">Aguardando sua resposta</p>
            <p className="text-sm text-muted-foreground">
              Precisamos de mais informações para continuar.{' '}
              <a
                href="#responder"
                className="font-medium text-primary underline underline-offset-2"
              >
                Responder agora
              </a>
              .
            </p>
          </div>
        </div>
      )}

      {/* Janela de aprovação (D-042): o solicitante aprova ou contesta. */}
      {aguardandoAprovacao && (
        <AprovacaoCliente
          chamadoId={chamado.id}
          prazoTexto={prazoAprovacao}
          custoFinalTexto={chamado.custo_final != null ? formatarBrl(chamado.custo_final) : null}
        />
      )}
      {/* Resolvido visto por um colega do tenant (D-037): só o status, sem ações. */}
      {resolvido && !meu && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Este chamado foi resolvido
          </p>
          <p className="text-sm text-muted-foreground">
            Aguardando a aprovação de {solicitanteNome}.
            {chamado.custo_final != null && ` Custo final: ${formatarBrl(chamado.custo_final)}.`}
          </p>
        </div>
      )}

      {/* Descrição */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Descrição</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className={classesConteudoRico}
            dangerouslySetInnerHTML={{ __html: chamado.descricao_html }}
          />
        </CardContent>
      </Card>

      {/* Timeline */}
      <div className="flex flex-col gap-3">
        <h2 className="font-heading text-sm font-semibold text-muted-foreground">Conversa</h2>
        {itens.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Ainda não há mensagens neste chamado.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {itens.map((item) =>
              item.tipo === 'mensagem' ? (
                <li key={`m-${item.m.id}`}>
                  <MensagemBolha
                    tipo={tipoAutor(item.m.autor_id)}
                    autor={nomeAutor(item.m.autor_id, tipoAutor(item.m.autor_id))}
                    html={item.m.corpo_html}
                    anexos={item.anexos}
                    quando={item.m.created_at}
                  />
                </li>
              ) : (
                <li key={`e-${item.e.id}`}>
                  <EventoLinha
                    autor={nomeAutor(item.e.ator_id, tipoAutor(item.e.ator_id))}
                    e={item.e}
                  />
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      {/* Responder / somente leitura (alheio) / estado encerrado */}
      {!encerrado && !meu ? (
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-4">
          <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Você está acompanhando um chamado de{' '}
            <span className="font-medium text-foreground">{solicitanteNome}</span>. Só o solicitante
            pode responder ou alterar este chamado.
          </p>
        </div>
      ) : aguardandoAprovacao ? null : !encerrado ? (
        /* Em `resolvido`, o solicitante fala pelo bloco Aprovar/Contestar (D-042). */
        <Card id="responder" className={cn(aguardando && 'border-primary/40')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="size-4" />
              Responder
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RespostaForm chamadoId={chamado.id} />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Este chamado está {ROTULO_STATUS_CHAMADO[chamado.status].toLowerCase()} e não recebe
            novas mensagens.{' '}
            {podeReabrir
              ? 'Se o assunto voltou, reabra-o para retomar o atendimento — ou abra um novo chamado.'
              : 'Precisa de mais alguma coisa?'}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            {/* Reabertura de encerrado (D-038): só o solicitante, como no resolvido. */}
            {podeReabrir && (
              <form action={acaoTransicionarCliente}>
                <input type="hidden" name="id" value={chamado.id} />
                <input type="hidden" name="novo_status" value={StatusChamado.em_atendimento} />
                <Button type="submit" variant="outline" size="sm">
                  <RotateCcw />
                  Reabrir
                </Button>
              </form>
            )}
            <Link
              href={`/portal/novo?ref=${chamado.numero}`}
              className={cn(buttonVariants({ size: 'sm' }))}
            >
              <Plus className="size-4" />
              Abrir novo chamado
            </Link>
          </div>
        </div>
      )}

      {/* Ação de cancelar (confirmação) */}
      {podeCancelar && (
        <div className="flex justify-end">
          <DialogoCancelar chamadoId={chamado.id} />
        </div>
      )}
    </div>
  );
}

function AvatarAutor({ tipo, autor }: { tipo: TipoAutor; autor: string }) {
  const base =
    'flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold';
  if (tipo === 'ia') {
    return (
      <span className={cn(base, 'bg-marca-acento/10 text-marca-acento')} aria-hidden>
        <Bot className="size-4" />
      </span>
    );
  }
  if (tipo === 'sistema') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')} aria-hidden>
        <CircleUser className="size-4" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        tipo === 'voce'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground',
      )}
      aria-hidden
    >
      {iniciais(autor)}
    </span>
  );
}

function MensagemBolha({
  tipo,
  autor,
  html,
  anexos,
  quando,
}: {
  tipo: TipoAutor;
  autor: string;
  html: string;
  anexos: Anexo[];
  quando: Date | string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <AvatarAutor tipo={tipo} autor={autor} />
        <span className="text-sm font-medium">{autor}</span>
        {tipo === 'ia' && <span className="text-xs text-muted-foreground">Assistente</span>}
        {tipo === 'solicitante' && (
          <span className="text-xs text-muted-foreground">Solicitante</span>
        )}
        {tipo === 'equipe' && <span className="text-xs text-muted-foreground">Suporte</span>}
        <span className="ml-auto text-xs text-muted-foreground" title={dataHoraAbsoluta(quando)}>
          {tempoRelativo(quando)}
        </span>
      </div>
      <div className={cn('pl-9', classesConteudoRico)} dangerouslySetInnerHTML={{ __html: html }} />
      {anexos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 pl-9">
          {anexos.map((a) => (
            <a
              key={a.id}
              href={`/api/anexos/${a.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
            >
              {a.nome_arquivo}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EventoLinha({ autor, e }: { autor: string; e: EventoView }) {
  const dados = e.dados as { de?: string; para?: string };
  let detalhe = '';
  if (e.tipo === 'status_alterado' && dados.de && dados.para) {
    const de = ROTULO_STATUS_CHAMADO[dados.de as StatusChamado] ?? dados.de;
    const para = ROTULO_STATUS_CHAMADO[dados.para as StatusChamado] ?? dados.para;
    detalhe = ` (${de} → ${para})`;
  }
  // D-043: faixa/valor do custo.
  const custo = detalheEventoCusto(e.tipo, e.dados);
  if (custo) detalhe = ` ${custo}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
      <span className="font-medium">{autor}</span>
      <span>
        {ROTULO_TIPO_EVENTO[e.tipo]}
        {detalhe}
      </span>
      <span className="ml-auto" title={dataHoraAbsoluta(e.created_at)}>
        {tempoRelativo(e.created_at)}
      </span>
    </div>
  );
}
