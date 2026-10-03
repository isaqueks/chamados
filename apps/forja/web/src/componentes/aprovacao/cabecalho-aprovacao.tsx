import type { AprovacaoDto } from '@comum/dto';
import {
  NivelVerificacaoBadge,
  SeloBanco,
  SeloDocsExigidas,
  SeloInterface,
  SeloRegraNegocio,
  SeloSensiveis,
} from '@/componentes/badges';
import { RotuloOrigem } from '@/componentes/execucao/suporte';
import { formatarCustoEquivalente } from '@/lib/formato';
import { patchCurto } from './regras-aprovar';

/**
 * Cabeçalho da Aprovação (specs/forja/06 §4.3): versão N do relatório (com o
 * que mudou), `patch-id` curto → branch de destino, selos ⚙, nível de
 * verificação (nunca arredondado), situação da revisão, ciclos e custo — tudo
 * "calculado pela Forja". Com "Relatório contradiz o diff" (F-12) os selos
 * dão lugar a uma faixa `destructive` de largura total (nunca um badge
 * pequeno). Clicar no selo de interface abre a aba Evidências; no de
 * sensíveis, filtra o diff.
 */

const ROTULO_REVISAO: Record<string, string> = {
  aprovado: 'aprovada',
  reprovado: 'reprovada',
  bloqueado: 'bloqueada',
};

export function CabecalhoAprovacao({
  aprovacao,
  aoAbrirEvidencias,
  aoFiltrarSensiveis,
}: {
  aprovacao: AprovacaoDto;
  aoAbrirEvidencias: () => void;
  aoFiltrarSensiveis: () => void;
}) {
  const a = aprovacao;
  const r = a.relatorio;
  const contradiz = a.alertas.find((x) => x.tipo === 'relatorio_contradiz');
  const mudou = a.versao > 1 ? (r.mudou_desde_a_ultima_versao ?? [])[0] : null;

  return (
    <header className="flex flex-col gap-3 border-b bg-card px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-tight">
            Aprovar <span className="text-muted-foreground">#{a.chamado.numero}</span>{' '}
            {a.chamado.titulo}
          </h1>
          <p className="text-sm text-muted-foreground">
            versão {a.versao}
            {mudou && <> (mudou: {mudou})</>}
          </p>
        </div>
        <p className="font-mono text-sm">
          patch <span className="font-semibold">{patchCurto(a.patch_id)}</span> → {a.branch_destino}
        </p>
      </div>

      {contradiz ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
        >
          RELATÓRIO CONTRADIZ O DIFF — {contradiz.mensagem}
          {contradiz.detalhes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 font-normal">
              {contradiz.detalhes.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SeloRegraNegocio altera={r.selos.altera_regra_negocio} />
          <SeloBanco altera={r.selos.altera_banco} />
          <button
            type="button"
            onClick={aoAbrirEvidencias}
            className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Abrir evidências de interface"
          >
            <SeloInterface
              telas={r.selos.altera_ui ? Math.max(1, r.alteracoes_de_interface.telas.length) : 0}
            />
          </button>
          <button
            type="button"
            onClick={aoFiltrarSensiveis}
            disabled={r.selos.sensivel.length === 0}
            className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Filtrar o diff pelos arquivos sensíveis"
          >
            <SeloSensiveis quantidade={r.selos.sensivel.length} />
          </button>
          {r.selos.docs_exigidas_ok !== null && <SeloDocsExigidas ok={r.selos.docs_exigidas_ok} />}
          <NivelVerificacaoBadge nivel={r.nivel_verificacao} />
        </div>
      )}

      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        <span>
          revisão: {ROTULO_REVISAO[a.revisao.decisao] ?? a.revisao.decisao}, {a.revisao.bloqueantes}{' '}
          {a.revisao.bloqueantes === 1 ? 'bloqueante' : 'bloqueantes'}
          {a.revisao.achados_abertos > 0 && ` · ${a.revisao.achados_abertos} achados em aberto`}
        </span>
        <span>
          · ciclos {a.ciclos.auto} auto + {a.ciclos.humano} humano
        </span>
        <span>· {formatarCustoEquivalente(a.custo_micro_usd)}</span>
        <span>· {a.descricao_entrega}</span>
        <RotuloOrigem origem="forja" className="ml-1" />
      </p>
    </header>
  );
}
