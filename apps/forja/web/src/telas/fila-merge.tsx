import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ExternalLinkIcon,
  GitMergeIcon,
  KeyRoundIcon,
  RotateCwIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import type { FilaMergeDto } from '@comum/dto';
import { api } from '@/lib/api';
import { horaLocal } from '@/lib/formato';
import { ROTULO_STATUS_CHAMADO } from '@/lib/rotulos';
import { Button, buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { useProjetoAtual } from '@/componentes/shell/projeto-atual';
import { Caixa } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Faixa,
  Pagina,
  Secao,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { formatarDataHora, plural, shaCurto } from '@/componentes/apoio/texto';
import { alternar } from '@/componentes/lote/logica';
import { ItemFilaMerge } from '@/componentes/merge/item-fila';
import {
  montarVisaoFilaMerge,
  novaOrdem,
  ROTULO_PASSO_OUTBOX,
  selecaoValida,
  type AlertaMerge,
  type FilaVisao,
} from '@/componentes/merge/logica';

/**
 * Fila de merge (specs/forja/06 §4.6; regras em 03 §7–§9, F-10, F-11, F-16).
 *
 * Ordem da tela = ordem do risco: faixas que travam o projeto (sentinela
 * divergente → fila e outbox travados, 05 §4.9; token de `schema` preso,
 * 03 §7.3), a fila serial por projeto × destino, as pendências com o Chamados
 * (o merge NUNCA é refeito — só o passo do outbox), o que aguarda "Publicado
 * em produção" (Gdeploy, em massa, com diálogo que lista cada chamado) e os
 * concluídos recentes (sem lembrete de IA: a Forja não mexe na IA do servidor, FJ-031).
 */

const CHAVE = ['merge'];

function AlertaTopo({ alerta }: { alerta: AlertaMerge }) {
  const [verDiff, setVerDiff] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const reconhecer = useComando({
    executar: () => api('execucao_reconhecer_sentinela', { params: { id: alerta.execucao_id } }),
    invalidar: [CHAVE],
    sucesso: 'Sentinela reconhecida: fila e outbox destravados',
    aoSucesso: () => setConfirmar(false),
  });
  const liberar = useComando({
    executar: () =>
      api('merge_liberar_token_schema', { entrada: { projeto_id: alerta.projeto_id } }),
    invalidar: [CHAVE],
    sucesso: 'Token de schema liberado',
    aoSucesso: () => setConfirmar(false),
  });

  if (alerta.tipo === 'sentinela') {
    return (
      <>
        <Faixa
          nivel="erro"
          icone={ShieldAlertIcon}
          acoes={
            <>
              <Button variant="outline" size="sm" onClick={() => setVerDiff(true)}>
                Ver diff
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirmar(true)}>
                Reconhecer…
              </Button>
            </>
          }
        >
          <span className="font-medium">Integridade:</span>{' '}
          {alerta.divergencias.length === 1
            ? `${alerta.divergencias[0]} mudou`
            : `${plural(alerta.divergencias.length, 'arquivo vigiado mudou', 'arquivos vigiados mudaram')}`}{' '}
          durante{' '}
          <Link to={`/execucoes/${alerta.execucao_id}`} className="underline">
            #{alerta.numero}
          </Link>{' '}
          — fila e outbox deste projeto travados.
        </Faixa>
        <Dialog open={verDiff} onOpenChange={setVerDiff}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Sentinela de integridade · #{alerta.numero}</DialogTitle>
              <DialogDescription>
                Arquivos fora da worktree que mudaram enquanto o agente rodava (calculado pela
                Forja).
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {alerta.divergencias.join('\n')}
            </pre>
          </DialogContent>
        </Dialog>
        <DialogoConfirmacao
          aberto={confirmar}
          aoMudarAberto={setConfirmar}
          titulo="Reconhecer a divergência?"
          descricao="Destrava a fila e o outbox deste projeto SEM desfazer nada. Confira o diff antes: se a mudança não foi sua, investigue o que o agente executou."
          rotuloConfirmar="Reconhecer"
          destrutivo
          pendente={reconhecer.isPending}
          aoConfirmar={() => reconhecer.mutate(undefined)}
        >
          <ul className="list-disc pl-5 font-mono text-xs">
            {alerta.divergencias.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </DialogoConfirmacao>
      </>
    );
  }

  return (
    <>
      <Faixa
        nivel="aviso"
        icone={KeyRoundIcon}
        acoes={
          <>
            <Link
              to={`/execucoes/${alerta.execucao_id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Abrir #{alerta.numero}
            </Link>
            <Button variant="outline" size="sm" onClick={() => setConfirmar(true)}>
              Liberar token…
            </Button>
          </>
        }
      >
        #{alerta.numero} segura o token de schema — nenhuma outra migration entra em voo.
      </Faixa>
      <DialogoConfirmacao
        aberto={confirmar}
        aoMudarAberto={setConfirmar}
        titulo="Liberar o token de schema?"
        descricao={`O #${alerta.numero} está parado precisando de você e ainda segura o token. Liberar deixa o próximo chamado de schema implementar — se o #${alerta.numero} voltar depois, duas migrations podem ter sido escritas contra a mesma base.`}
        rotuloConfirmar="Liberar token"
        destrutivo
        pendente={liberar.isPending}
        aoConfirmar={() => liberar.mutate(undefined)}
      />
    </>
  );
}

function FilaDestino({ visao }: { visao: FilaVisao }) {
  const { fila } = visao;
  const mover = useComando({
    executar: (e: { itemId: string; nova_ordem: number }) =>
      api('merge_reordenar', { params: { id: e.itemId }, entrada: { nova_ordem: e.nova_ordem } }),
    invalidar: [CHAVE],
  });

  const linhas = [
    ...(visao.emProcessamento ? [visao.emProcessamento] : []),
    ...visao.aguardando,
    ...visao.fora,
  ];
  const destino = `${fila.branch_destino}${fila.remoto ? ` (${fila.remoto})` : ' (local)'}`;

  return (
    <Secao
      titulo={`${fila.projeto_nome} → ${destino}`}
      acoes={<span className="text-xs text-muted-foreground">serial, 1 por vez</span>}
    >
      {fila.aviso_copia_local && <Faixa nivel="aviso">{fila.aviso_copia_local}</Faixa>}
      {linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada na fila deste destino.</p>
      ) : (
        <Card className="gap-0 py-0">
          <ol className="divide-y">
            {linhas.map((item, i) => {
              const reordenavel = item.estado === 'aguardando';
              return (
                <ItemFilaMerge
                  key={item.id}
                  item={item}
                  posicao={i + 1}
                  podeSubir={reordenavel && novaOrdem(visao.aguardando, item.id, 'subir') !== null}
                  podeDescer={
                    reordenavel && novaOrdem(visao.aguardando, item.id, 'descer') !== null
                  }
                  movendo={mover.isPending}
                  aoMover={
                    reordenavel && visao.aguardando.length > 1
                      ? (direcao) => {
                          const ordem = novaOrdem(visao.aguardando, item.id, direcao);
                          if (ordem !== null) mover.mutate({ itemId: item.id, nova_ordem: ordem });
                        }
                      : null
                  }
                />
              );
            })}
          </ol>
        </Card>
      )}
    </Secao>
  );
}

function Pendencias({ dto }: { dto: ReturnType<typeof montarVisaoFilaMerge>['pendencias'] }) {
  const tentar = useComando({
    executar: (execucaoId: string) => api('outbox_tentar_agora', { params: { id: execucaoId } }),
    invalidar: [CHAVE],
    sucesso: 'Nova tentativa enviada',
  });
  if (dto.length === 0) return null;
  return (
    <Secao
      titulo="Pendências com o Chamados"
      descricao="O merge já foi feito e nunca é refeito: só o passo que falhou é reenviado."
    >
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {dto.map((p) => (
            <li
              key={`${p.execucao_id}:${p.passo}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <Link to={`/execucoes/${p.execucao_id}`} className="font-medium hover:underline">
                #{p.numero}
              </Link>
              <span className="text-muted-foreground">
                mergeado{p.sha_merge ? ` (${shaCurto(p.sha_merge)})` : ''} ·{' '}
                {ROTULO_PASSO_OUTBOX[p.passo]} não enviado: {p.erro}
                {p.ultimo_http ? ` (HTTP ${p.ultimo_http})` : ''}
                {p.proxima_em ? ` · próxima tentativa ${horaLocal(p.proxima_em)}` : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={tentar.isPending && tentar.variables === p.execucao_id}
                onClick={() => tentar.mutate(p.execucao_id)}
              >
                <RotateCwIcon aria-hidden />
                Tentar agora
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </Secao>
  );
}

function APublicar({ itens }: { itens: FilaMergeDto['a_publicar'] }) {
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [confirmar, setConfirmar] = useState(false);
  useEffect(() => setSelecao((s) => selecaoValida(s, itens)), [itens]);
  const escolhidos = itens.filter((i) => selecao.has(i.execucao_id));

  const publicar = useComando({
    executar: () =>
      api('merge_publicado_producao', {
        entrada: { execucao_ids: escolhidos.map((e) => e.execucao_id) },
      }),
    invalidar: [CHAVE],
    sucesso: () =>
      `${plural(escolhidos.length, 'chamado liberado', 'chamados liberados')}: resposta e status seguem para o Chamados`,
    aoSucesso: () => {
      setConfirmar(false);
      setSelecao(new Set());
    },
  });

  if (itens.length === 0) return null;
  return (
    <Secao
      titulo="A publicar (aguardando deploy)"
      descricao="Resposta e status ficam retidos até você confirmar que o código está em produção."
      acoes={
        <Button disabled={escolhidos.length === 0} onClick={() => setConfirmar(true)}>
          Publicado em produção ({escolhidos.length})…
        </Button>
      }
    >
      <Card className="py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2 px-4">
          <Caixa
            marcada={escolhidos.length === itens.length}
            aoMudar={(m) => setSelecao(m ? new Set(itens.map((i) => i.execucao_id)) : new Set())}
            rotulo="Todos"
          />
          {itens.map((i) => (
            <Caixa
              key={i.execucao_id}
              marcada={selecao.has(i.execucao_id)}
              aoMudar={() => setSelecao((s) => alternar(s, i.execucao_id))}
              rotulo={`#${i.numero} ${i.titulo}`}
            />
          ))}
        </div>
      </Card>
      <DialogoConfirmacao
        aberto={confirmar}
        aoMudarAberto={setConfirmar}
        titulo="Publicado em produção?"
        descricao="Para cada chamado abaixo, a Forja publica a resposta retida e muda o status no Chamados. Confirme só o que já está no ar."
        rotuloConfirmar={`Confirmar ${escolhidos.length}`}
        bloqueado={escolhidos.length === 0}
        pendente={publicar.isPending}
        aoConfirmar={() => publicar.mutate(undefined)}
        largo
      >
        <ul className="flex flex-col divide-y rounded-lg border">
          {escolhidos.map((e) => (
            <li key={e.execucao_id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                #{e.numero} {e.titulo}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                merge {shaCurto(e.sha_merge)}
              </span>
            </li>
          ))}
        </ul>
      </DialogoConfirmacao>
    </Secao>
  );
}

function Concluidos({ itens }: { itens: FilaMergeDto['concluidos_recentes'] }) {
  if (itens.length === 0) return null;
  return (
    <Secao titulo="Concluídos recentes">
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {itens.map((c) => (
            <li
              key={c.execucao_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <Link to={`/execucoes/${c.execucao_id}`} className="font-medium hover:underline">
                #{c.numero}
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {c.titulo} · {ROTULO_STATUS_CHAMADO[c.status_final].toLowerCase()}{' '}
                {formatarDataHora(c.concluido_em)}
              </span>
              {c.url_no_chamados && (
                <a
                  href={c.url_no_chamados}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  <ExternalLinkIcon aria-hidden />
                  Abrir chamado
                </a>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </Secao>
  );
}

export function TelaFilaMerge() {
  const { projetoId } = useProjetoAtual();
  const consulta = useQuery({
    queryKey: [...CHAVE, projetoId],
    queryFn: ({ signal }) =>
      api('merge_obter', {
        entrada: projetoId ? { projeto_id: projetoId } : {},
        sinal: signal,
      }),
    refetchInterval: 5_000,
  });
  const visao = useMemo(
    () => (consulta.data ? montarVisaoFilaMerge(consulta.data, projetoId) : null),
    [consulta.data, projetoId],
  );

  return (
    <Pagina>
      <CabecalhoPagina
        titulo="Fila de merge"
        descricao="O que está entrando na branch de destino, o que falta comunicar e o que aguarda deploy."
      />
      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError || !visao ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : visao.vazia ? (
        <Vazio
          icone={GitMergeIcon}
          titulo="Nada na fila."
          descricao="Aprovações viram itens aqui."
        />
      ) : (
        <>
          {visao.alertas.map((a) => (
            <AlertaTopo key={`${a.tipo}:${a.execucao_id}`} alerta={a} />
          ))}
          {visao.filas.map((f) => (
            <FilaDestino key={f.chave} visao={f} />
          ))}
          <Pendencias dto={visao.pendencias} />
          <APublicar itens={visao.aPublicar} />
          <Concluidos itens={visao.concluidos} />
        </>
      )}
    </Pagina>
  );
}
