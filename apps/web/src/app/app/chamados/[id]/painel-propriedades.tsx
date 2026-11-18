'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  ehReabertura,
  ORDEM_ESTIMATIVA_CUSTO,
  rotuloEstimativaCusto,
  formatarBrl,
  parsearValorBrl,
  valorParaCampo,
  MENSAGEM_VALOR_BRL,
  type EstimativaCusto,
} from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from '@/lib/rotulos';
import type { OperadorResumo } from '@chamados/db';
import {
  acaoTransicionar,
  acaoAssumir,
  acaoAtribuir,
  acaoDesatribuir,
  acaoAlterarPrioridade,
  acaoAlterarNatureza,
  acaoDefinirComplexidade,
  acaoDefinirEstimativaCusto,
  acaoDefinirCustoFinal,
  type ResultadoAcao,
} from '../actions';
import { DialogoResolver } from './dialogo-resolver';

const SELECT_CLS =
  'h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60';

/** Verbo de ação por status-alvo (rótulo dos botões de transição — specs/08 §4.3). */
const ACAO_STATUS: Record<StatusChamado, string> = {
  [StatusChamado.novo]: 'Voltar a novo',
  [StatusChamado.em_triagem]: 'Enviar à triagem',
  [StatusChamado.aguardando_cliente]: 'Pedir informações',
  [StatusChamado.em_atendimento]: 'Assumir atendimento',
  [StatusChamado.resolvido]: 'Marcar resolvido',
  [StatusChamado.fechado]: 'Fechar',
  [StatusChamado.cancelado]: 'Cancelar',
};

function verbo(de: StatusChamado, para: StatusChamado): string {
  // Reabertura de resolvido/fechado/cancelado (specs/04 §8.2, D-038).
  if (ehReabertura(de, para)) return 'Reabrir';
  return ACAO_STATUS[para];
}

interface Props {
  chamadoId: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  /** D-043: faixa estimada (pública) e custo final em BRL. */
  estimativaCusto: EstimativaCusto | null;
  custoFinal: number | null;
  alvosStatus: StatusChamado[];
  operadores: OperadorResumo[];
  operadorAtualId: string | null;
  meuId: string;
  encerrado: boolean;
}

export function PainelPropriedades({
  chamadoId,
  status,
  natureza,
  prioridade,
  complexidade,
  estimativaCusto,
  custoFinal,
  alvosStatus,
  operadores,
  operadorAtualId,
  meuId,
  encerrado,
}: Props) {
  const [pendente, startTransition] = useTransition();
  const [resolverAberto, setResolverAberto] = useState(false);

  function executar(fn: () => Promise<ResultadoAcao>, aoConcluir?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.msg);
        aoConcluir?.();
      } else toast.error(r.msg);
    });
  }

  const atribuidoAMim = operadorAtualId === meuId;

  return (
    <div className="flex flex-col gap-5">
      {/* Status + transições */}
      <Secao titulo="Status">
        {alvosStatus.length > 0 ? (
          <div className="flex flex-col gap-2">
            {alvosStatus.map((para) => (
              <Button
                key={para}
                variant={para === StatusChamado.resolvido ? 'default' : 'outline'}
                size="sm"
                disabled={pendente}
                className="justify-start"
                onClick={() =>
                  // D-043: resolver passa pela confirmação com custo final opcional.
                  para === StatusChamado.resolvido
                    ? setResolverAberto(true)
                    : executar(() => acaoTransicionar(chamadoId, para))
                }
              >
                {verbo(status, para)}
                <span className="ml-auto text-xs text-muted-foreground">
                  → {ROTULO_STATUS_CHAMADO[para]}
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nenhuma transição disponível a partir de “{ROTULO_STATUS_CHAMADO[status]}”.
          </p>
        )}
        {alvosStatus.includes(StatusChamado.resolvido) && (
          <DialogoResolver
            key={String(custoFinal)}
            aberto={resolverAberto}
            aoMudarAberto={setResolverAberto}
            custoAtual={custoFinal}
            pendente={pendente}
            aoConfirmar={(custo) =>
              executar(
                () => acaoTransicionar(chamadoId, StatusChamado.resolvido, custo),
                () => setResolverAberto(false),
              )
            }
          />
        )}
      </Secao>

      {/* Atribuição */}
      <Secao titulo="Atribuição">
        <div className="flex flex-col gap-2">
          <select
            aria-label="Operador responsável"
            className={SELECT_CLS}
            value={operadorAtualId ?? ''}
            disabled={pendente || encerrado}
            onChange={(e) => {
              const v = e.target.value;
              executar(() => (v ? acaoAtribuir(chamadoId, v) : acaoDesatribuir(chamadoId)));
            }}
          >
            <option value="">Não atribuído</option>
            {operadores.map((op) => (
              <option key={op.id} value={op.id}>
                {op.nome}
              </option>
            ))}
          </select>
          {!atribuidoAMim && !encerrado && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pendente}
              onClick={() => executar(() => acaoAssumir(chamadoId))}
            >
              Atribuir a mim
            </Button>
          )}
        </div>
      </Secao>

      {/* Classificação */}
      <Secao titulo="Classificação">
        <div className="flex flex-col gap-3">
          <Campo rotulo="Prioridade">
            <select
              aria-label="Prioridade"
              className={SELECT_CLS}
              value={prioridade}
              disabled={pendente || encerrado}
              onChange={(e) => executar(() => acaoAlterarPrioridade(chamadoId, e.target.value))}
            >
              {Object.values(Prioridade).map((p) => (
                <option key={p} value={p}>
                  {ROTULO_PRIORIDADE[p]}
                </option>
              ))}
            </select>
          </Campo>

          <Campo rotulo="Natureza">
            <select
              aria-label="Natureza"
              className={SELECT_CLS}
              value={natureza}
              disabled={pendente || encerrado}
              onChange={(e) => executar(() => acaoAlterarNatureza(chamadoId, e.target.value))}
            >
              {Object.values(Natureza).map((n) => (
                <option key={n} value={n}>
                  {ROTULO_NATUREZA[n]}
                </option>
              ))}
            </select>
          </Campo>

          <Campo rotulo="Complexidade (interna)">
            <select
              aria-label="Complexidade"
              className={SELECT_CLS}
              value={complexidade ?? ''}
              disabled={pendente || encerrado}
              onChange={(e) => executar(() => acaoDefinirComplexidade(chamadoId, e.target.value))}
            >
              <option value="">Não classificada</option>
              {Object.values(Complexidade).map((c) => (
                <option key={c} value={c}>
                  {ROTULO_COMPLEXIDADE[c]}
                </option>
              ))}
            </select>
          </Campo>
        </div>
      </Secao>

      {/* Custo (D-043) — visível ao cliente no portal. */}
      <Secao titulo="Custo">
        <div className="flex flex-col gap-3">
          <Campo rotulo="Estimativa de custo">
            <select
              aria-label="Estimativa de custo"
              className={SELECT_CLS}
              value={estimativaCusto ?? ''}
              disabled={pendente || encerrado}
              onChange={(e) =>
                executar(() => acaoDefinirEstimativaCusto(chamadoId, e.target.value))
              }
            >
              <option value="">Sem estimativa</option>
              {ORDEM_ESTIMATIVA_CUSTO.map((est) => (
                <option key={est} value={est}>
                  {rotuloEstimativaCusto(est)}
                </option>
              ))}
            </select>
          </Campo>

          {status === StatusChamado.resolvido ? (
            <CampoCustoFinal
              key={String(custoFinal)}
              custoFinal={custoFinal}
              pendente={pendente}
              aoSalvar={(valor) => executar(() => acaoDefinirCustoFinal(chamadoId, valor))}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Custo final</span>
              <p className="text-sm">
                {custoFinal !== null ? (
                  <span className="font-medium tabular-nums">{formatarBrl(custoFinal)}</span>
                ) : (
                  <span className="text-muted-foreground">
                    {encerrado ? 'Não informado.' : 'Informado ao marcar como resolvido.'}
                  </span>
                )}
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            O cliente vê a estimativa e o custo final.
          </p>
        </div>
      </Secao>
    </div>
  );
}

/**
 * Custo final editável (só em `resolvido` — D-043): texto pt-BR com vírgula
 * decimal, validado no cliente com a MESMA regra do servidor
 * (`parsearValorBrl`). Em branco + salvar = remover o custo.
 */
function CampoCustoFinal({
  custoFinal,
  pendente,
  aoSalvar,
}: {
  custoFinal: number | null;
  pendente: boolean;
  aoSalvar: (valor: string) => void;
}) {
  const inicial = valorParaCampo(custoFinal);
  const [valor, setValor] = useState(inicial);
  const lido = valor.trim() === '' ? null : parsearValorBrl(valor);
  const erro = lido && !lido.ok ? MENSAGEM_VALOR_BRL[lido.motivo] : null;
  const mudou = valor.trim() !== inicial;

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!erro && mudou) aoSalvar(valor);
      }}
    >
      <label htmlFor="custo-final" className="text-sm text-muted-foreground">
        Custo final (R$)
      </label>
      <div className="flex gap-2">
        <Input
          id="custo-final"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          value={valor}
          disabled={pendente}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? 'custo-final-erro' : undefined}
          onChange={(e) => setValor(e.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="h-9"
          disabled={pendente || !mudou || erro !== null}
        >
          Salvar
        </Button>
      </div>
      {erro && (
        <p id="custo-final-erro" className="text-xs text-destructive">
          {erro}
        </p>
      )}
    </form>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {titulo}
      </h3>
      {children}
    </div>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{rotulo}</span>
      {children}
    </label>
  );
}
