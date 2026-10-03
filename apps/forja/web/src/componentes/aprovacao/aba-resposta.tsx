import { useEffect, useMemo, useState } from 'react';
import type { RespostaRegistrada, ValidacaoResposta } from '@comum/contratos';
import { api } from '@/lib/api';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { BlocoProveniencia, CaixaMarcacao, RotuloOrigem } from '@/componentes/execucao/suporte';
import {
  explicarViolacoes,
  marcarTrechos,
  urlsNoTexto,
  validarLocalmente,
} from './validacao-resposta';

/**
 * Aba "Resposta ao cliente" (specs/forja/06 §4.3; F-16, F-20, U-5): editor com
 * preview "como o cliente verá" (texto puro, nada vira HTML) e o nome do
 * operador dedicado como autor. Validação ao vivo: a prévia local
 * (`validarLocalmente`, mesmos detectores do Chamados) e, 400 ms depois de
 * parar de digitar, a do servidor (soma o léxico extra e a regra de
 * disponibilidade do `tipo`). Cada violação é sublinhada no preview e
 * explicada; uma violação só passa com "publicar mesmo assim". O `tipo`
 * (`aguardando_publicacao`/`disponivel`) segue `merge_publica` do projeto e é
 * só informativo aqui.
 */

const ROTULO_TIPO: Record<RespostaRegistrada['tipo'], string> = {
  aguardando_publicacao: 'aguardando publicação (o merge não publica)',
  disponivel: 'disponível (o merge publica)',
  pergunta: 'pergunta ao cliente',
};

/** Validação viva: prévia local imediata, substituída pela do servidor quando chega. */
export function useValidacaoResposta(
  execucaoId: string,
  texto: string,
  tipo: RespostaRegistrada['tipo'],
): { validacao: ValidacaoResposta; doServidor: boolean } {
  const local = useMemo(() => validarLocalmente(texto), [texto]);
  const [servidor, setServidor] = useState<{ texto: string; v: ValidacaoResposta } | null>(null);

  useEffect(() => {
    const controle = new AbortController();
    const t = setTimeout(() => {
      api('aprovacao_validar_resposta', {
        params: { id: execucaoId },
        entrada: { texto, tipo },
        sinal: controle.signal,
      })
        .then((v) => setServidor({ texto, v }))
        .catch(() => {
          // Sem o servidor, vale a prévia local (ele valida de novo ao publicar).
        });
    }, 400);
    return () => {
      clearTimeout(t);
      controle.abort();
    };
  }, [execucaoId, texto, tipo]);

  if (servidor && servidor.texto === texto) return { validacao: servidor.v, doServidor: true };
  return { validacao: local, doServidor: false };
}

export function AbaResposta({
  texto,
  aoMudarTexto,
  original,
  autor,
  validacao,
  doServidor,
  publicarMesmoAssim,
  aoMudarPublicarMesmoAssim,
}: {
  texto: string;
  aoMudarTexto: (t: string) => void;
  original: RespostaRegistrada;
  autor: string | null;
  validacao: ValidacaoResposta;
  doServidor: boolean;
  publicarMesmoAssim: boolean;
  aoMudarPublicarMesmoAssim: (v: boolean) => void;
}) {
  const violacoes = explicarViolacoes(validacao);
  const segmentos = marcarTrechos(
    texto,
    violacoes.map((v) => v.item),
  );
  const urls = urlsNoTexto(texto);
  const editada = texto !== original.corpo_markdown;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor="resposta-cliente">Mensagem pública</Label>
          <span className="text-xs text-muted-foreground">
            tipo: {ROTULO_TIPO[original.tipo]} · {texto.length} caracteres
            {editada && ' · editada por você'}
          </span>
        </div>
        <Textarea
          id="resposta-cliente"
          value={texto}
          onChange={(e) => aoMudarTexto(e.target.value)}
          className="min-h-64 font-sans"
        />
        <div className="flex items-center justify-between gap-2">
          <RotuloOrigem origem="agente" />
          {editada && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => aoMudarTexto(original.corpo_markdown)}
            >
              Restaurar o rascunho do agente
            </button>
          )}
        </div>

        <section aria-live="polite" className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Validador {doServidor ? '' : '(prévia local)'}
          </h4>
          {violacoes.length === 0 ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-300">
              ✓ sem conteúdo técnico nem promessa de correção
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {violacoes.map((v, i) => (
                <li key={i} className="text-rose-700 dark:text-rose-300">
                  <span className="font-medium underline decoration-wavy underline-offset-4">
                    {v.item}
                  </span>
                  : {v.explicacao}
                </li>
              ))}
            </ul>
          )}
          {!validacao.ok && (
            <CaixaMarcacao
              marcado={publicarMesmoAssim}
              aoMudar={aoMudarPublicarMesmoAssim}
              rotulo="Publicar mesmo assim (fica registrado com os motivos)"
            />
          )}
          {urls.length > 0 && (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Links na resposta (confira o destino):{' '}
              <span className="font-mono break-all">{urls.join(' · ')}</span>
            </p>
          )}
        </section>
      </div>

      <BlocoProveniencia origem="forja" titulo="Como o cliente verá" className="h-fit">
        <div className="rounded-lg border bg-card p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {autor ?? 'operador dedicado (configure em Conexão)'} · mensagem pública
          </p>
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
            {segmentos.map((s, i) =>
              s.marcado ? (
                <mark
                  key={i}
                  className="bg-transparent text-inherit underline decoration-rose-500 decoration-wavy underline-offset-4"
                >
                  {s.texto}
                </mark>
              ) : (
                <span key={i}>{s.texto}</span>
              ),
            )}
          </p>
        </div>
      </BlocoProveniencia>
    </div>
  );
}
