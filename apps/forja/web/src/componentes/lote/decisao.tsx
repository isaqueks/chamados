import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatarPerguntasCliente } from '@chamados/shared';
import type { PlanoV1, ValidacaoResposta } from '@comum/contratos';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Caixa, Campo, CampoSelect } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';

/**
 * Saídas do gate de decisão a partir da mesa (specs/forja/06 §5.3):
 *
 * - **Eu decido**: uma resposta por pergunta/decisão; [Usar suposição padrão]
 *   preenche sozinho. O planejador é retomado e a decisão vai para o
 *   relatório como "decisão do operador".
 * - **Perguntar ao cliente**: rascunho validado AO VIVO pelo mesmo validador
 *   da resposta (F-16, rota `aprovacao_validar_resposta` com `tipo:
 *   'pergunta'`), preview "como o cliente verá" e confirmação explícita antes
 *   de publicar — a mensagem é pública e leva o chamado a aguardar o cliente.
 */

type Perguntas = PlanoV1['perguntas_ao_cliente'];
type Decisoes = PlanoV1['decisoes_do_operador'];

export function DialogoEuDecido({
  execucaoId,
  numero,
  perguntas,
  decisoes,
  aberto,
  aoMudarAberto,
  invalidar,
}: {
  execucaoId: string;
  numero: number;
  perguntas: Perguntas;
  decisoes: Decisoes;
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
  invalidar: unknown[][];
}) {
  const [respPerguntas, setRespPerguntas] = useState<string[]>([]);
  const [respDecisoes, setRespDecisoes] = useState<string[]>([]);

  // Reinicia só ao ABRIR: o polling da mesa recria os arrays a cada consulta e
  // não pode apagar o que o usuário está digitando.
  const origem = useRef({ perguntas, decisoes });
  origem.current = { perguntas, decisoes };
  useEffect(() => {
    if (!aberto) return;
    const o = origem.current;
    setRespPerguntas(o.perguntas.map(() => ''));
    setRespDecisoes(
      o.decisoes.map((d) => (d.opcoes.includes(d.recomendacao) ? d.recomendacao : '')),
    );
  }, [aberto]);

  const completo =
    respPerguntas.length === perguntas.length &&
    respDecisoes.length === decisoes.length &&
    [...respPerguntas, ...respDecisoes].every((r) => r.trim().length > 0);

  const comando = useComando({
    executar: () =>
      api('execucao_decidir', {
        params: { id: execucaoId },
        entrada: {
          modo: 'eu_decido',
          respostas: [
            ...respPerguntas.map((r, indice) => ({
              tipo: 'pergunta' as const,
              indice,
              resposta: r.trim(),
            })),
            ...respDecisoes.map((r, indice) => ({
              tipo: 'decisao' as const,
              indice,
              resposta: r.trim(),
            })),
          ],
        },
      }),
    invalidar,
    sucesso: `#${numero}: decisão registrada; o planejador retoma`,
    aoSucesso: () => aoMudarAberto(false),
  });

  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={aoMudarAberto}
      titulo={`Eu decido · #${numero}`}
      descricao="Suas respostas retomam o planejador e ficam no relatório como decisão do operador."
      rotuloConfirmar="Registrar e replanejar"
      bloqueado={!completo}
      pendente={comando.isPending}
      aoConfirmar={() => comando.mutate(undefined)}
      largo
    >
      {perguntas.map((p, i) => (
        <div key={`p${i}`} className="flex flex-col gap-1.5 rounded-lg border p-3">
          <p className="font-medium">{p.pergunta}</p>
          <p className="text-xs text-muted-foreground">Por que importa: {p.por_que_importa}</p>
          <Campo rotulo="Sua resposta">
            {(id) => (
              <Input
                id={id}
                value={respPerguntas[i] ?? ''}
                onChange={(e) =>
                  setRespPerguntas((r) => r.map((v, j) => (j === i ? e.target.value : v)))
                }
              />
            )}
          </Campo>
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() =>
              setRespPerguntas((r) => r.map((v, j) => (j === i ? p.suposicao_padrao : v)))
            }
          >
            Usar suposição padrão: “{p.suposicao_padrao}”
          </Button>
        </div>
      ))}
      {decisoes.map((d, i) => (
        <div key={`d${i}`} className="flex flex-col gap-1.5 rounded-lg border p-3">
          <p className="font-medium">{d.questao}</p>
          <p className="text-xs text-muted-foreground">Recomendação do agente: {d.recomendacao}</p>
          <Campo rotulo="Sua escolha">
            {(id) => (
              <CampoSelect
                id={id}
                valor={respDecisoes[i] || null}
                placeholder="Escolha uma opção"
                opcoes={d.opcoes.map((o) => ({ valor: o, rotulo: o }))}
                aoMudar={(v) => setRespDecisoes((r) => r.map((x, j) => (j === i ? v : x)))}
              />
            )}
          </Campo>
        </div>
      ))}
    </DialogoConfirmacao>
  );
}

function useDebounce<T>(valor: T, ms: number): T {
  const [atrasado, setAtrasado] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setAtrasado(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return atrasado;
}

const ROTULO_VIOLACAO: Record<Exclude<keyof ValidacaoResposta, 'ok'>, string> = {
  tecnico: 'Conteúdo técnico (o cliente não deve ver)',
  promessa: 'Promessa de resolução',
  lexico: 'Termo proibido',
  disponibilidade: 'Fala de disponibilidade/deploy',
};

export function ListaViolacoes({ validacao }: { validacao: ValidacaoResposta }) {
  const grupos = (Object.keys(ROTULO_VIOLACAO) as (keyof typeof ROTULO_VIOLACAO)[]).filter(
    (k) => validacao[k].length > 0,
  );
  if (grupos.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      {grupos.map((k) => (
        <li key={k}>
          <span className="font-medium">{ROTULO_VIOLACAO[k]}:</span> {validacao[k].join('; ')}
        </li>
      ))}
    </ul>
  );
}

export function DialogoPerguntarCliente({
  execucaoId,
  numero,
  perguntas,
  aberto,
  aoMudarAberto,
  invalidar,
  rascunho,
}: {
  execucaoId: string;
  numero: number;
  perguntas: Perguntas;
  aberto: boolean;
  aoMudarAberto: (v: boolean) => void;
  invalidar: unknown[][];
  /** Rascunho já redigido (ex.: pelo planejador); sem ele, as perguntas formatadas. */
  rascunho?: string | null;
}) {
  const [texto, setTexto] = useState('');
  const [mesmoAssim, setMesmoAssim] = useState(false);
  const [etapa, setEtapa] = useState<'editar' | 'confirmar'>('editar');

  const origemRef = useRef({ perguntas, rascunho });
  origemRef.current = { perguntas, rascunho };
  useEffect(() => {
    if (!aberto) return;
    const o = origemRef.current;
    setTexto(
      o.rascunho?.trim() || formatarPerguntasCliente(o.perguntas.map((p) => p.pergunta)) || '',
    );
    setMesmoAssim(false);
    setEtapa('editar');
  }, [aberto]);

  const textoValidado = useDebounce(texto, 500);
  const validacao = useQuery({
    queryKey: ['validar-pergunta', execucaoId, textoValidado],
    queryFn: ({ signal }) =>
      api('aprovacao_validar_resposta', {
        params: { id: execucaoId },
        entrada: { texto: textoValidado, tipo: 'pergunta' },
        sinal: signal,
      }),
    enabled: aberto && textoValidado.trim().length > 0,
    staleTime: Infinity,
  });

  const atualizada = textoValidado === texto && !validacao.isFetching;
  const violou = validacao.data ? !validacao.data.ok : false;
  const podeSeguir =
    texto.trim().length > 0 && atualizada && !!validacao.data && (!violou || mesmoAssim);

  const comando = useComando({
    executar: () =>
      api('execucao_decidir', {
        params: { id: execucaoId },
        entrada: {
          modo: 'perguntar_cliente',
          texto_pergunta: texto.trim(),
          publicar_mesmo_assim: violou && mesmoAssim,
        },
      }),
    invalidar,
    sucesso: `#${numero}: pergunta enviada; aguardando o cliente`,
    aoSucesso: () => aoMudarAberto(false),
  });

  if (etapa === 'confirmar') {
    return (
      <DialogoConfirmacao
        aberto={aberto}
        aoMudarAberto={(v) => (v ? undefined : setEtapa('editar'))}
        titulo={`Publicar pergunta no #${numero}?`}
        descricao="A mensagem é pública (o cliente recebe) e o chamado passa a aguardar o cliente."
        rotuloConfirmar="Publicar pergunta"
        pendente={comando.isPending}
        aoConfirmar={() => comando.mutate(undefined)}
        largo
      >
        <div className="rounded-lg border bg-card p-3 whitespace-pre-wrap">{texto.trim()}</div>
        {violou && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Você marcou “publicar mesmo assim” apesar dos avisos do validador.
          </p>
        )}
      </DialogoConfirmacao>
    );
  }

  return (
    <DialogoConfirmacao
      aberto={aberto}
      aoMudarAberto={aoMudarAberto}
      titulo={`Perguntar ao cliente · #${numero}`}
      descricao="Rascunho editável. É validado ao vivo pelas mesmas regras da resposta ao cliente."
      rotuloConfirmar="Revisar e publicar…"
      bloqueado={!podeSeguir}
      aoConfirmar={() => setEtapa('confirmar')}
      largo
    >
      <Campo rotulo="Mensagem ao cliente">
        {(id) => (
          <Textarea id={id} value={texto} onChange={(e) => setTexto(e.target.value)} rows={8} />
        )}
      </Campo>
      {validacao.isError ? (
        <p className="text-xs text-destructive">
          Não foi possível validar o texto agora; sem validação a pergunta não é publicada.
        </p>
      ) : !atualizada ? (
        <p className="text-xs text-muted-foreground">Validando…</p>
      ) : validacao.data && !violou ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          Nenhum problema encontrado pelo validador.
        </p>
      ) : null}
      {validacao.data && <ListaViolacoes validacao={validacao.data} />}
      {violou && (
        <Caixa
          marcada={mesmoAssim}
          aoMudar={setMesmoAssim}
          rotulo="Publicar mesmo assim"
          descricao="Fica registrado na execução, com os motivos do validador."
        />
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Como o cliente verá
        </span>
        <div className="rounded-lg border border-dashed p-3 whitespace-pre-wrap">
          {texto.trim() || '—'}
        </div>
      </div>
    </DialogoConfirmacao>
  );
}
