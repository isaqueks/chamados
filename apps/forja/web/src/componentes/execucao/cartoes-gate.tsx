import { useMemo, useState } from 'react';
import { PlanoV1 } from '@comum/contratos';
import type {
  AcaoExecucao,
  DecisaoNecessariaDto,
  DecidirDto,
  ExecucaoDto,
  PlanoExecucaoDto,
} from '@comum/dto';
import { api } from '@/lib/api';
import { horaLocal } from '@/lib/formato';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { DialogoPerguntarCliente } from '@/componentes/lote/decisao';
import { botoesDecisao } from './acoes-execucao';
import { BlocoProveniencia, Faixa, TextoSeguro } from './suporte';
import { useComando } from '@/componentes/apoio/comando';

/**
 * Cartões de gate na coluna do plano (specs/forja/06 §4.2 e §5.3):
 *
 * - **Aprovar plano** (G1, `aguardando_plano`): [Aprovar plano] [Editar e
 *   aprovar] [Comentar e replanejar] [Descartar]. O plano editado vira o
 *   oficial (F-11) — a edição é do JSON do `plano.v1`, revalidado aqui com o
 *   MESMO schema zod do contrato antes de enviar (o servidor valida de novo).
 * - **Decisão necessária** (Gdec, `aguardando_decisao`, e depois
 *   `aguardando_cliente_resposta`): para cada pergunta, `pergunta`,
 *   `por_que_importa` e `suposicao_padrao`; para cada decisão, `questao`,
 *   `opcoes` e `recomendacao`. Saídas: Perguntar ao cliente (diálogo com
 *   validação no servidor, prévia e confirmação, F-16), Eu decido (com [Usar
 *   suposição padrão]) ou Descartar. Com a resposta do cliente detectada (o
 *   servidor passa a oferecer `replanejar`), aparece **Replanejar** (06 §5.3
 *   passo 4).
 */

const chavesExecucao = (id: string) => [['execucao', id]];

export function CartaoAprovarPlano({
  execucaoId,
  plano,
  acoes,
  aoDescartar,
}: {
  execucaoId: string;
  plano: PlanoExecucaoDto;
  /** `ExecucaoDto.acoes`: cada botão só aparece se o servidor o oferecer. */
  acoes: readonly AcaoExecucao[];
  aoDescartar: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [comentando, setComentando] = useState(false);
  const [json, setJson] = useState('');
  const [comentario, setComentario] = useState('');

  const aprovar = useComando({
    executar: (plano_editado?: PlanoV1) =>
      api('execucao_aprovar_plano', {
        params: { id: execucaoId },
        entrada: { artefato_id: plano.artefato_id, plano_editado },
      }),
    sucesso: 'Plano aprovado.',
    invalidar: chavesExecucao(execucaoId),
    aoSucesso: () => setEditando(false),
  });
  const comentar = useComando({
    executar: (texto: string) =>
      api('execucao_comentar_plano', { params: { id: execucaoId }, entrada: { texto } }),
    sucesso: 'Comentário enviado: o planejador vai replanejar.',
    invalidar: chavesExecucao(execucaoId),
    aoSucesso: () => setComentando(false),
  });

  const validacao = useMemo(() => {
    if (!editando) return null;
    try {
      const r = PlanoV1.safeParse(JSON.parse(json));
      return r.success
        ? { ok: true as const, plano: r.data }
        : {
            ok: false as const,
            erro: r.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .slice(0, 5)
              .join('\n'),
          };
    } catch {
      return { ok: false as const, erro: 'JSON inválido.' };
    }
  }, [editando, json]);

  function abrirEdicao(): void {
    // Só os campos do contrato do modelo: os ⚙ do app (sha_base, gate_g1…) não se editam.
    const base = Object.fromEntries(
      Object.entries(plano.plano).filter(([k]) => k in PlanoV1.shape),
    );
    setJson(JSON.stringify(base, null, 2));
    setEditando(true);
  }

  return (
    <Faixa tom="aviso" titulo="Aprovar plano">
      <p>
        O plano abaixo precisa da sua aprovação antes da implementação
        {plano.plano.gate_g1.motivos.length > 0 && <> ({plano.plano.gate_g1.motivos.join('; ')})</>}
        .
      </p>
      <div className="flex flex-wrap gap-2">
        {acoes.includes('aprovar_plano') && (
          <>
            <Button
              size="sm"
              onClick={() => aprovar.mutate(undefined)}
              disabled={aprovar.isPending}
            >
              Aprovar plano
            </Button>
            <Button size="sm" variant="outline" onClick={abrirEdicao}>
              Editar e aprovar
            </Button>
          </>
        )}
        {acoes.includes('comentar_plano') && (
          <Button size="sm" variant="outline" onClick={() => setComentando(true)}>
            Comentar e replanejar
          </Button>
        )}
        {acoes.includes('descartar') && (
          <Button size="sm" variant="ghost" onClick={aoDescartar}>
            Descartar
          </Button>
        )}
      </div>

      <Dialog open={editando} onOpenChange={setEditando}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Editar e aprovar o plano</DialogTitle>
            <DialogDescription>
              O plano editado vira o oficial e fica registrado como editado por você.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="h-[50vh] font-mono text-xs"
            aria-label="Plano em JSON"
            spellCheck={false}
          />
          {validacao && !validacao.ok && (
            <pre className="text-xs whitespace-pre-wrap text-destructive">{validacao.erro}</pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!validacao?.ok || aprovar.isPending}
              onClick={() => validacao?.ok && aprovar.mutate(validacao.plano)}
            >
              Aprovar plano editado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={comentando} onOpenChange={setComentando}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Comentar e replanejar</DialogTitle>
            <DialogDescription>
              O planejador refaz o plano levando o seu comentário.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            aria-label="Comentário"
            placeholder="ex.: use paginação por cursor, não offset"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setComentando(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!comentario.trim() || comentar.isPending}
              onClick={() => comentar.mutate(comentario.trim())}
            >
              Enviar e replanejar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Faixa>
  );
}

/**
 * Cartão "Decisão necessária" — em `aguardando_decisao` e também em
 * `aguardando_cliente_resposta` (06 §5.3): os botões vêm de `ExecucaoDto.acoes`
 * (`botoesDecisao`). "Perguntar ao cliente" é o MESMO diálogo da mesa de planos
 * (`DialogoPerguntarCliente`): validação no servidor (F-16), prévia "como o
 * cliente verá" e confirmação antes de publicar — a mensagem é pública.
 */
export function CartaoDecisao({
  execucao,
  aoDescartar,
}: {
  execucao: ExecucaoDto;
  aoDescartar: () => void;
}) {
  const ex = execucao;
  const decisao = ex.decisao as DecisaoNecessariaDto;
  const execucaoId = ex.id;
  const botoes = botoesDecisao(ex);
  const [decidindo, setDecidindo] = useState(false);
  const [perguntando, setPerguntando] = useState(false);
  const [respostas, setRespostas] = useState<Record<string, string>>({});

  const decidir = useComando({
    executar: (entrada: DecidirDto) =>
      api('execucao_decidir', { params: { id: execucaoId }, entrada }),
    sucesso: 'Decisão registrada.',
    invalidar: chavesExecucao(execucaoId),
    aoSucesso: () => setDecidindo(false),
  });
  const replanejar = useComando({
    executar: () => api('execucao_replanejar', { params: { id: execucaoId } }),
    sucesso: 'Replanejando com a resposta do cliente.',
    invalidar: chavesExecucao(execucaoId),
  });

  const itens = [
    ...decisao.perguntas.map((p, indice) => ({ tipo: 'pergunta' as const, indice, p })),
    ...decisao.decisoes.map((d, indice) => ({ tipo: 'decisao' as const, indice, d })),
  ];
  const chave = (tipo: string, indice: number) => `${tipo}:${indice}`;
  const todasRespondidas = itens.every((i) => (respostas[chave(i.tipo, i.indice)] ?? '').trim());

  function usarSuposicoes(): void {
    const novo: Record<string, string> = { ...respostas };
    decisao.perguntas.forEach((p, i) => (novo[chave('pergunta', i)] = p.suposicao_padrao));
    decisao.decisoes.forEach((d, i) => (novo[chave('decisao', i)] = d.recomendacao));
    setRespostas(novo);
  }

  const aguardandoCliente = ex.estado === 'aguardando_cliente_resposta';

  return (
    <BlocoProveniencia origem="agente" titulo="Decisão necessária">
      {decisao.perguntas.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Perguntas ao cliente
          </h4>
          {decisao.perguntas.map((p, i) => (
            <div key={i} className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">{p.pergunta}</span>
              <span className="text-muted-foreground">Por que importa: {p.por_que_importa}</span>
              <span className="text-muted-foreground">Suposição padrão: {p.suposicao_padrao}</span>
            </div>
          ))}
        </section>
      )}
      {decisao.decisoes.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Decisões suas
          </h4>
          {decisao.decisoes.map((d, i) => (
            <div key={i} className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">{d.questao}</span>
              <span className="text-muted-foreground">Opções: {d.opcoes.join(' · ')}</span>
              <span className="text-muted-foreground">Recomendação: {d.recomendacao}</span>
            </div>
          ))}
        </section>
      )}

      {aguardandoCliente && !botoes.replanejar && (
        <Faixa tom="info" titulo="Pergunta enviada ao cliente">
          {decisao.pergunta_publicada_em
            ? `Publicada às ${horaLocal(decisao.pergunta_publicada_em) ?? '—'}. `
            : ''}
          Aguardando a resposta; o Chamados é relido a cada 3 min.
        </Faixa>
      )}
      {decisao.resposta_cliente && (
        <BlocoProveniencia
          origem="cliente"
          titulo={`Resposta de ${decisao.resposta_cliente.autor_nome}`}
        >
          <TextoSeguro texto={decisao.resposta_cliente.corpo_markdown} />
        </BlocoProveniencia>
      )}
      {botoes.replanejar && (
        <Faixa
          tom="sucesso"
          titulo="O cliente respondeu"
          acoes={
            <Button
              size="sm"
              onClick={() => replanejar.mutate(undefined)}
              disabled={replanejar.isPending}
            >
              Replanejar
            </Button>
          }
        >
          O planejador refaz o plano com a resposta como dado (a resposta está na conversa do
          chamado).
        </Faixa>
      )}

      {(botoes.perguntar || botoes.decidir || botoes.descartar) && (
        <div className="flex flex-wrap gap-2">
          {botoes.perguntar && (
            <Button size="sm" variant="outline" onClick={() => setPerguntando(true)}>
              Perguntar ao cliente…
            </Button>
          )}
          {botoes.decidir && (
            <Button
              size="sm"
              variant={decidindo ? 'default' : 'outline'}
              onClick={() => setDecidindo(true)}
            >
              Eu decido
            </Button>
          )}
          {botoes.descartar && (
            <Button size="sm" variant="ghost" onClick={aoDescartar}>
              Descartar
            </Button>
          )}
        </div>
      )}

      {botoes.perguntar && (
        <DialogoPerguntarCliente
          execucaoId={execucaoId}
          numero={ex.chamado.numero}
          perguntas={decisao.perguntas}
          rascunho={decisao.rascunho_pergunta?.corpo_markdown ?? null}
          aberto={perguntando}
          aoMudarAberto={setPerguntando}
          invalidar={chavesExecucao(execucaoId)}
        />
      )}

      {decidindo && botoes.decidir && (
        <div className="flex flex-col gap-3">
          <div>
            <Button size="xs" variant="outline" onClick={usarSuposicoes}>
              Usar suposição padrão
            </Button>
          </div>
          {itens.map((i) => {
            const k = chave(i.tipo, i.indice);
            const rotulo = i.tipo === 'pergunta' ? i.p.pergunta : i.d.questao;
            return (
              <div key={k} className="flex flex-col gap-1">
                <Label htmlFor={`resp-${k}`}>{rotulo}</Label>
                {i.tipo === 'decisao' && (
                  <div className="flex flex-wrap gap-1">
                    {i.d.opcoes.map((o) => (
                      <Button
                        key={o}
                        size="xs"
                        variant={respostas[k] === o ? 'default' : 'outline'}
                        onClick={() => setRespostas({ ...respostas, [k]: o })}
                      >
                        {o}
                      </Button>
                    ))}
                  </div>
                )}
                <Input
                  id={`resp-${k}`}
                  value={respostas[k] ?? ''}
                  onChange={(e) => setRespostas({ ...respostas, [k]: e.target.value })}
                />
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              disabled={!todasRespondidas || decidir.isPending}
              onClick={() =>
                decidir.mutate({
                  modo: 'eu_decido',
                  respostas: itens.map((i) => ({
                    tipo: i.tipo,
                    indice: i.indice,
                    resposta: (respostas[chave(i.tipo, i.indice)] ?? '').trim(),
                  })),
                })
              }
            >
              Registrar decisão e replanejar
            </Button>
          </div>
        </div>
      )}
    </BlocoProveniencia>
  );
}
