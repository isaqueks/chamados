import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstadoExecucao } from '../../comum/estados';
import type { Execucao } from '../db/entidades/execucao';
import { removerWorktree } from '../git';
import type { Nucleo } from './nucleo';

/**
 * Retenção e limpeza (specs/forja/02 §9). Duas camadas:
 * - `planejarRetencao` (PURA): dado o que existe e o relógio, decide o que
 *   expira — testável por unidade, sem disco;
 * - `aplicarRetencao`: executa o plano (git worktree remove, `rm` dos
 *   diretórios da execução, expurgo de `evento` e `uso_assinatura`).
 *
 * O que NÃO expira (02 §9): linhas de `execucao`, `etapa`, `artefato`,
 * `aprovacao`, `outbox_chamado`, `item_fila_merge` — histórico auditável. E
 * worktree de `falhou`/`precisa_humano` parada NUNCA sai sem confirmação: ela
 * só aparece em `confirmar` (tela Worktrees).
 */

const DIA_MS = 86_400_000;
/** `uso_assinatura`: 30 dias (02 §9). */
export const USO_ASSINATURA_DIAS = 30;

export interface ItemRetencao {
  execucao_id: string;
  numero: number;
  dir: string;
}

export interface PlanoRetencao {
  /** Worktrees a remover já (concluído; descartado/cancelado vencidos). */
  remover_worktrees: (ItemRetencao & { repo_dir: string; apagar_branch: string | null })[];
  /** Worktrees paradas em falha vencidas: só com confirmação humana (tela Worktrees). */
  confirmar: ItemRetencao[];
  /** `evidencias/` (prints FJ-026). */
  apagar_evidencias: ItemRetencao[];
  /** `etapas/` (eventos.jsonl/stderr.log) + linhas de `evento` de origem cli/comando/chamados. */
  apagar_brutos: ItemRetencao[];
  /** `entrada/` (dado do cliente) sai junto com a worktree. */
  apagar_entrada: ItemRetencao[];
  /** Corte de `uso_assinatura`. */
  uso_antes_de: string;
}

export interface EntradaRetencao {
  execucoes: readonly Pick<
    Execucao,
    | 'id'
    | 'numero'
    | 'estado'
    | 'worktree_dir'
    | 'branch'
    | 'sha_merge'
    | 'concluido_em'
    | 'atualizado_em'
    | 'config_snapshot'
  >[];
  repoDir: (execucaoId: string) => string;
  dirExecucao: (execucaoId: string) => string;
  existe: (caminho: string) => boolean;
  agora: Date;
}

const ENCERRADA_SEM_MERGE: readonly EstadoExecucao[] = ['descartado', 'cancelado'];
const PARADA_EM_FALHA: readonly EstadoExecucao[] = ['falhou', 'precisa_humano'];

function venceu(desde: string | null, dias: number, agora: Date): boolean {
  if (!desde) return false;
  const t = Date.parse(desde);
  return Number.isFinite(t) && agora.getTime() - t >= dias * DIA_MS;
}

export function planejarRetencao(e: EntradaRetencao): PlanoRetencao {
  const plano: PlanoRetencao = {
    remover_worktrees: [],
    confirmar: [],
    apagar_evidencias: [],
    apagar_brutos: [],
    apagar_entrada: [],
    uso_antes_de: new Date(e.agora.getTime() - USO_ASSINATURA_DIAS * DIA_MS).toISOString(),
  };
  for (const x of e.execucoes) {
    const r = x.config_snapshot.retencao;
    const base = { execucao_id: x.id, numero: x.numero };
    const dirExec = e.dirExecucao(x.id);
    const wt = x.worktree_dir && e.existe(x.worktree_dir) ? x.worktree_dir : null;
    let saiWorktree = false;
    if (wt && x.estado === 'concluido') {
      plano.remover_worktrees.push({
        ...base,
        dir: wt,
        repo_dir: e.repoDir(x.id),
        apagar_branch: null,
      });
      saiWorktree = true;
    } else if (
      wt &&
      ENCERRADA_SEM_MERGE.includes(x.estado) &&
      venceu(x.concluido_em, r.worktree_descartada_dias, e.agora)
    ) {
      // Apaga a branch local SÓ se nunca foi mergeada nem enviada (02 §9).
      plano.remover_worktrees.push({
        ...base,
        dir: wt,
        repo_dir: e.repoDir(x.id),
        apagar_branch: x.sha_merge ? null : x.branch,
      });
      saiWorktree = true;
    } else if (
      wt &&
      PARADA_EM_FALHA.includes(x.estado) &&
      venceu(x.atualizado_em, r.worktree_falha_dias, e.agora)
    ) {
      plano.confirmar.push({ ...base, dir: wt });
    }
    const entrada = join(dirExec, 'entrada');
    if (
      (saiWorktree ||
        (!wt && (x.estado === 'concluido' || ENCERRADA_SEM_MERGE.includes(x.estado)))) &&
      e.existe(entrada)
    ) {
      plano.apagar_entrada.push({ ...base, dir: entrada });
    }
    const evid = join(dirExec, 'evidencias');
    if (
      e.existe(evid) &&
      (ENCERRADA_SEM_MERGE.includes(x.estado) ||
        (x.estado === 'concluido' && venceu(x.concluido_em, r.evidencias_dias, e.agora)))
    ) {
      plano.apagar_evidencias.push({ ...base, dir: evid });
    }
    const brutos = join(dirExec, 'etapas');
    const encerrada = x.estado === 'concluido' || ENCERRADA_SEM_MERGE.includes(x.estado);
    if (encerrada && e.existe(brutos) && venceu(x.concluido_em, r.eventos_brutos_dias, e.agora)) {
      plano.apagar_brutos.push({ ...base, dir: brutos });
    }
  }
  return plano;
}

export interface ResumoRetencao {
  worktrees_removidas: number;
  evidencias_apagadas: number;
  brutos_apagados: number;
  eventos_expurgados: number;
  uso_expurgado: number;
  aguardando_confirmacao: ItemRetencao[];
  erros: string[];
}

export async function aplicarRetencao(n: Nucleo, plano: PlanoRetencao): Promise<ResumoRetencao> {
  const resumo: ResumoRetencao = {
    worktrees_removidas: 0,
    evidencias_apagadas: 0,
    brutos_apagados: 0,
    eventos_expurgados: 0,
    uso_expurgado: 0,
    aguardando_confirmacao: plano.confirmar,
    erros: [],
  };
  for (const w of plano.remover_worktrees) {
    try {
      await removerWorktree(w.repo_dir, w.dir, {
        dirDados: n.deps.dirDados,
        apagarBranch: w.apagar_branch,
      });
      resumo.worktrees_removidas += 1;
    } catch (e) {
      resumo.erros.push(`#${w.numero} worktree: ${(e as Error).message}`);
    }
  }
  for (const d of [...plano.apagar_entrada, ...plano.apagar_evidencias]) {
    await rm(d.dir, { recursive: true, force: true });
  }
  resumo.evidencias_apagadas = plano.apagar_evidencias.length;
  for (const d of plano.apagar_brutos) await rm(d.dir, { recursive: true, force: true });
  resumo.brutos_apagados = plano.apagar_brutos.length;
  const ids = plano.apagar_brutos.map((d) => d.execucao_id);
  resumo.eventos_expurgados = await n.banco.transacao((r) => r.eventos.expurgar(ids));
  resumo.uso_expurgado = await n.banco.transacao((r) =>
    r.usoAssinatura.expurgarAntesDe(plano.uso_antes_de),
  );
  return resumo;
}

/** Roda a retenção inteira (o orquestrador chama no boot e 1×/dia). */
export async function executarRetencao(n: Nucleo): Promise<ResumoRetencao> {
  const d = await n.banco.ler(async (r) => ({
    execs: await r.execucoes.listar(),
    projetos: await r.projetos.listar(),
  }));
  const repoDe = new Map(
    d.execs.map((x) => [x.id, d.projetos.find((p) => p.id === x.projeto_id)?.repo_dir ?? '']),
  );
  const plano = planejarRetencao({
    execucoes: d.execs,
    repoDir: (id) => repoDe.get(id) ?? '',
    dirExecucao: (id) => n.dirExecucao(id),
    existe: existsSync,
    agora: n.agora(),
  });
  return aplicarRetencao(n, plano);
}
