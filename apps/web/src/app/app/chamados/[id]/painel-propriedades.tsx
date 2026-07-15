'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import { Button } from '@/components/ui/button';
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
  type ResultadoAcao,
} from '../actions';

const SELECT_CLS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60';

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
  if (para === StatusChamado.em_atendimento && de === StatusChamado.resolvido) return 'Reabrir';
  return ACAO_STATUS[para];
}

interface Props {
  chamadoId: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
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
  alvosStatus,
  operadores,
  operadorAtualId,
  meuId,
  encerrado,
}: Props) {
  const [pendente, startTransition] = useTransition();

  function executar(fn: () => Promise<ResultadoAcao>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.msg);
      else toast.error(r.msg);
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
                onClick={() => executar(() => acaoTransicionar(chamadoId, para))}
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
    </div>
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
