import Link from 'next/link';
import { notFound } from 'next/navigation';
import { In } from 'typeorm';
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
import { Papel, StatusChamado, VisibilidadeMensagem, transicoesDoPapel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_TIPO_EVENTO,
  ROTULO_PAPEL,
  VARIANTE_STATUS,
  iniciais,
} from '@/lib/rotulos';
import { RespostaForm } from './resposta-form';
import { acaoTransicionar } from '../actions';

/** Verbo de ação por status-alvo (rótulo dos botões de transição). */
const ACAO_STATUS: Record<StatusChamado, string> = {
  [StatusChamado.novo]: 'Voltar a novo',
  [StatusChamado.em_triagem]: 'Enviar à triagem',
  [StatusChamado.aguardando_cliente]: 'Pedir informações',
  [StatusChamado.em_atendimento]: 'Atender',
  [StatusChamado.resolvido]: 'Resolver',
  [StatusChamado.fechado]: 'Fechar',
  [StatusChamado.cancelado]: 'Cancelar',
};

function acaoRotulo(de: StatusChamado, para: StatusChamado): string {
  if (para === StatusChamado.em_atendimento && de === StatusChamado.resolvido) return 'Reabrir';
  return ACAO_STATUS[para];
}

/** Eventos que NÃO viram linha própria na timeline (já aparecem como mensagem). */
const EVENTOS_OCULTOS_NA_TIMELINE = new Set<string>([
  'mensagem_publicada',
  'nota_interna_publicada',
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
  const ehCliente = usuario.papel === Papel.cliente;
  const podeInterna = usuario.papel === Papel.operador || usuario.papel === Papel.admin;
  const encerrado =
    chamado.status === StatusChamado.fechado || chamado.status === StatusChamado.cancelado;
  const alvos = transicoesDoPapel(usuario.papel, chamado.status);

  // Timeline unificada (mensagens + eventos), ordenada por data.
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
    if (EVENTOS_OCULTOS_NA_TIMELINE.has(e.tipo)) continue;
    itens.push({ tipo: 'evento', at: new Date(e.created_at).getTime(), e });
  }
  itens.sort((a, b) => a.at - b.at);

  const autorLabel = (autorId: string | null): string => {
    if (!autorId) return 'Sistema';
    return nomes[autorId]?.nome ?? 'Usuário';
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/app/chamados" className="text-sm text-muted-foreground hover:underline">
          ← Voltar aos chamados
        </Link>
      </div>

      {/* Cabeçalho */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">
              #{String(chamado.numero)}
            </span>
            <CardTitle className="text-xl">{chamado.titulo}</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant={VARIANTE_STATUS[chamado.status]}>
              {ROTULO_STATUS_CHAMADO[chamado.status]}
            </Badge>
            <Badge variant="outline">{ROTULO_NATUREZA[chamado.natureza]}</Badge>
            <Badge variant="muted">{ROTULO_PRIORIDADE[chamado.prioridade]}</Badge>
            {'complexidade' in chamado && chamado.complexidade && (
              <Badge variant="secondary">complexidade: {chamado.complexidade}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div
            className="prose-chamado text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: chamado.descricao_html }}
          />
        </CardContent>
      </Card>

      {/* Ações de status */}
      {alvos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {alvos.map((para) => (
            <form key={para} action={acaoTransicionar}>
              <input type="hidden" name="id" value={chamado.id} />
              <input type="hidden" name="novo_status" value={para} />
              <Button type="submit" variant="outline" size="sm">
                {acaoRotulo(chamado.status, para)}
              </Button>
            </form>
          ))}
        </div>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Mensagens e histórico do chamado.</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* Responder */}
      {!encerrado ? (
        <Card>
          <CardHeader>
            <CardTitle>{podeInterna ? 'Responder / nota interna' : 'Responder'}</CardTitle>
            {ehCliente && (
              <CardDescription>Sua mensagem fica visível para a equipe de suporte.</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <RespostaForm chamadoId={chamado.id} podeInterna={podeInterna} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Chamado {ROTULO_STATUS_CHAMADO[chamado.status].toLowerCase()} — não recebe novas
          mensagens.
        </p>
      )}
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
        (interna ? 'border-amber-300 bg-amber-50/60 dark:bg-amber-950/20' : 'bg-card')
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {iniciais(autor)}
        </div>
        <span className="text-sm font-medium">{autor}</span>
        {papel && <span className="text-xs text-muted-foreground">{ROTULO_PAPEL[papel]}</span>}
        {interna && <Badge variant="secondary">Nota interna</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(quando).toLocaleString('pt-BR')}
        </span>
      </div>
      <div
        className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      <span className="font-medium">{autor}</span>
      <span>
        {ROTULO_TIPO_EVENTO[e.tipo]}
        {detalhe}
      </span>
      <span className="ml-auto">{new Date(e.created_at).toLocaleString('pt-BR')}</span>
    </div>
  );
}
