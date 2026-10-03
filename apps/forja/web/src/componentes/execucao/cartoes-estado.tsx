import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ExecucaoDto, ResolverPendenciaDto } from '@comum/dto';
import { api } from '@/lib/api';
import { horaLocal } from '@/lib/formato';
import { ROTULO_MOTIVO_ESTADO } from '@/lib/rotulos';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { formatarDuracao } from './formato-execucao';
import { CaixaMarcacao, Faixa } from './suporte';
import { useComando } from '@/componentes/apoio/comando';

/**
 * Faixas de estado da Execução (specs/forja/06 §4.2 "Vazios e erros",
 * "Possivelmente travado", 03 §2.4 ações de `precisa_humano`):
 *
 * - sem atividade (`sem_atividade_desde`, limiar do projeto) → âmbar com
 *   [Pausar e conversar] [Parar] — sem kill automático;
 * - `falhou` → rose com a causa classificada e [Tentar de novo] [Abrir Diagnóstico];
 * - `pausado_cota` → "retoma automaticamente às HH:MM", e [Retomar agora mesmo
 *   assim] só se o servidor o oferecer (o projeto autoriza créditos extras);
 * - `precisa_humano` → motivo legível + as ações válidas para ele
 *   (mais um ciclo / seguir com achados / replanejar), com confirmação de
 *   orçamento quando o motivo foi timeout ou orçamento;
 * - sentinela divergente → rose com [Reconhecer] (destrava sem desfazer).
 */

export function CartoesEstado({
  execucao,
  semAtividadeMs,
  aoPausar,
  aoParar,
}: {
  execucao: ExecucaoDto;
  semAtividadeMs: number | null;
  aoPausar: () => void;
  aoParar: () => void;
}) {
  const ex = execucao;
  const invalidar = [['execucao', ex.id]];
  const [pendencia, setPendencia] = useState<ResolverPendenciaDto['acao'] | null>(null);
  const [instrucao, setInstrucao] = useState('');
  const [confirmarOrcamento, setConfirmarOrcamento] = useState(false);

  const retomarMesmoAssim = useComando({
    executar: () =>
      api('execucao_retomar', { params: { id: ex.id }, entrada: { mesmo_assim: true } }),
    sucesso: 'Retomando com créditos extras.',
    invalidar,
  });
  const reconhecer = useComando({
    executar: () => api('execucao_reconhecer_sentinela', { params: { id: ex.id } }),
    sucesso: 'Sentinela reconhecida.',
    invalidar,
  });
  const resolver = useComando({
    executar: (entrada: ResolverPendenciaDto) =>
      api('execucao_resolver_pendencia', { params: { id: ex.id }, entrada }),
    sucesso: 'Pendência resolvida.',
    invalidar,
    aoSucesso: () => {
      setPendencia(null);
      setInstrucao('');
      setConfirmarOrcamento(false);
    },
  });
  const tentar = useComando({
    executar: () => api('execucao_tentar_novamente', { params: { id: ex.id } }),
    sucesso: 'Tentando de novo.',
    invalidar,
  });

  const motivo =
    ex.motivo_texto ?? (ex.motivo_estado ? ROTULO_MOTIVO_ESTADO[ex.motivo_estado] : null);
  const exigeOrcamento =
    ex.motivo_estado === 'timeout_etapa' || ex.motivo_estado === 'orcamento_etapa';

  const faixas: ReactNode[] = [];

  if (ex.sentinela && ex.sentinela.divergencias.length > 0 && !ex.sentinela.reconhecida_em) {
    faixas.push(
      <Faixa
        key="sentinela"
        tom="erro"
        titulo="Integridade: a sentinela mudou durante esta execução"
        acoes={
          ex.acoes.includes('reconhecer_sentinela') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => reconhecer.mutate(undefined)}
              disabled={reconhecer.isPending}
            >
              Reconhecer
            </Button>
          )
        }
      >
        <ul className="list-disc pl-4 font-mono text-xs">
          {ex.sentinela.divergencias.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </Faixa>,
    );
  }

  if (semAtividadeMs !== null && ex.grupo === 'trabalhando') {
    faixas.push(
      <Faixa
        key="travado"
        tom="aviso"
        titulo={`Sem atividade há ${formatarDuracao(semAtividadeMs)}`}
        acoes={
          <>
            {ex.acoes.includes('pausar') && (
              <Button size="sm" variant="outline" onClick={aoPausar}>
                Pausar e conversar
              </Button>
            )}
            {ex.acoes.includes('parar') && (
              <Button size="sm" variant="destructive" onClick={aoParar}>
                Parar
              </Button>
            )}
          </>
        }
      >
        A Forja não encerra o processo sozinha.
      </Faixa>,
    );
  }

  if (ex.estado === 'falhou') {
    faixas.push(
      <Faixa
        key="falhou"
        tom="erro"
        titulo={`Falhou${motivo ? `: ${motivo}` : ''}`}
        acoes={
          <>
            {ex.acoes.includes('tentar_novamente') && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => tentar.mutate(undefined)}
                disabled={tentar.isPending}
              >
                Tentar de novo
              </Button>
            )}
            <Button size="sm" variant="ghost" render={<Link to="/diagnostico" />}>
              Abrir Diagnóstico
            </Button>
          </>
        }
      >
        O detalhe (stderr) está no Transcript bruto da última etapa.
      </Faixa>,
    );
  }

  if (ex.estado === 'pausado_cota') {
    faixas.push(
      <Faixa
        key="cota"
        tom="info"
        titulo={`Pausado pela cota: retoma automaticamente às ${horaLocal(ex.retoma_em) ?? '—'}`}
        acoes={
          ex.acoes.includes('retomar_mesmo_assim') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => retomarMesmoAssim.mutate(undefined)}
              disabled={retomarMesmoAssim.isPending}
            >
              Retomar agora mesmo assim
            </Button>
          )
        }
      />,
    );
  }

  if (ex.estado === 'interrompido') {
    faixas.push(
      <Faixa
        key="interrompido"
        tom="aviso"
        titulo="Interrompida: o servidor reiniciou durante uma etapa"
      >
        Revise e retome, ou descarte.
      </Faixa>,
    );
  }

  const acoesPendencia = (['mais_um_ciclo', 'seguir_com_achados', 'replanejar'] as const).filter(
    (a) => ex.acoes.includes(a),
  );
  if (ex.estado === 'precisa_humano') {
    faixas.push(
      <Faixa
        key="humano"
        tom="erro"
        titulo={`Precisa de você${motivo ? `: ${motivo}` : ''}`}
        acoes={acoesPendencia.map((a) => (
          <Button key={a} size="sm" variant="outline" onClick={() => setPendencia(a)}>
            {ROTULO_PENDENCIA[a]}
          </Button>
        ))}
      >
        {ex.motivo_estado === 'conflito_merge' && (
          <span>Resolva assumindo no terminal ou abra a worktree no chat livre.</span>
        )}
      </Faixa>,
    );
  }

  return (
    <>
      {faixas.length > 0 && <div className="flex flex-col gap-2">{faixas}</div>}
      <DialogoConfirmacao
        aberto={pendencia !== null}
        aoMudarAberto={(v) => !v && setPendencia(null)}
        titulo={pendencia ? ROTULO_PENDENCIA[pendencia] : ''}
        descricao={pendencia ? DESCRICAO_PENDENCIA[pendencia] : undefined}
        rotuloConfirmar="Confirmar"
        bloqueado={exigeOrcamento && pendencia === 'mais_um_ciclo' && !confirmarOrcamento}
        pendente={resolver.isPending}
        aoConfirmar={() =>
          pendencia &&
          resolver.mutate({
            acao: pendencia,
            instrucao: instrucao.trim() || undefined,
            confirmar_orcamento:
              exigeOrcamento && pendencia === 'mais_um_ciclo' ? confirmarOrcamento : undefined,
          })
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instrucao-pendencia">Instrução (opcional)</Label>
            <Textarea
              id="instrucao-pendencia"
              value={instrucao}
              onChange={(e) => setInstrucao(e.target.value)}
            />
          </div>
          {exigeOrcamento && pendencia === 'mais_um_ciclo' && (
            <CaixaMarcacao
              marcado={confirmarOrcamento}
              aoMudar={setConfirmarOrcamento}
              rotulo="Confirmo o novo orçamento/tempo desta etapa"
            />
          )}
        </div>
      </DialogoConfirmacao>
    </>
  );
}

const ROTULO_PENDENCIA = {
  mais_um_ciclo: 'Mais um ciclo',
  seguir_com_achados: 'Seguir com os achados',
  replanejar: 'Replanejar',
} as const;

const DESCRICAO_PENDENCIA = {
  mais_um_ciclo:
    'O condutor faz mais um ciclo de implementação e revisão. Conta para o teto total.',
  seguir_com_achados:
    'Segue para o relatório com os achados em aberto; eles aparecem na aprovação.',
  replanejar: 'O planejador refaz o plano a partir do chamado e da sua instrução.',
} as const;
