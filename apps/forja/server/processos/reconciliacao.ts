import { ETAPAS_DO_APP, type PassoOutbox, type TipoEtapa } from '../../comum/estados';
import type { TipoSessaoTerminal } from '../../comum/estados';
import { dentroDe, type EstadoSondado, type ProcessoParaSondar } from './proc-linux';

/**
 * Reconciliação no boot (specs/forja/01 §6.7, §9.1; 03 §9.5, §11): "nenhum
 * filho de antes sobrevive sem dono". Depois de um crash (ou SIGKILL) do app,
 * o banco diz que havia etapas executando, PTYs abertos, itens integrando e
 * passos do outbox enviando — mas o processo Node que os acompanhava morreu.
 *
 * POR QUE devolver AÇÕES em vez de executá-las: o algoritmo é a parte que
 * precisa de teste exaustivo (casos de 03 §11) e não pode depender de SQLite,
 * git ou `/proc` reais. Quem lê o mundo são as `FontesReconciliacao` e as
 * `SondasReconciliacao`; quem aplica as ações (escada via `Supervisor`, UPDATE
 * no banco, eventos) é a R3. Ordem das ações = ordem de aplicação:
 *
 * 1. `encerrar_grupo` — primeiro matar (um condutor órfão em bypass continua
 *    editando a worktree até aqui, 03 §11). Não dá para reanexar ao stdout de
 *    outro processo (04 §7.4), então vivo também morre.
 * 1b. `varrer_cwd` — para TODA etapa de agente/verificação que estava
 *    `executando`, com o processo vivo, morto ou sem pid: os comandos do Bash
 *    do agente rodam em `setsid` [V S4] e sobrevivem ao `claude` (que segue
 *    ≥ 35 s depois do SIGKILL no app). Só a varredura do cwd os acha (01 §6.7).
 * 2. `etapa_interrompida` / `execucao_interrompida` — o orquestrador decide a
 *    retomada (commit de checkpoint + `--resume`, 01 §6.7); verificação
 *    recomeça do zero; `integrar` vai pela regra do merge.
 * 3. `sessao_terminal_encerrada` — PTY órfão; a assumida mantém o estado
 *    `assumido_manual` ([Reabrir] faz `--resume` de novo).
 * 4. Worktrees × execuções ativas: órfã, ausente, `prunable`.
 * 5. Fila de merge (03 §9.5): `sha_merge` já ancestral da ref de destino →
 *    `mergeado` (NUNCA re-mergeia); senão recomeça do passo 1 de §8.1.
 * 6. Outbox `enviando` → checagem "já feito?" antes de qualquer reenvio (§9.2).
 */

export interface EtapaComProcesso {
  etapa_id: string;
  execucao_id: string;
  tipo: TipoEtapa;
  pid: number | null;
  pgid: number | null;
  session_id: string | null;
  /** argv[0] gravado no registro; ausente = deduzido do tipo da etapa. */
  comando?: string | null;
}

export interface SessaoTerminalAberta {
  sessao_terminal_id: string;
  tipo: TipoSessaoTerminal;
  pid: number | null;
  pgid: number | null;
  execucao_id: string | null;
  session_id_claude: string | null;
}

/** Uma entrada de `git worktree list --porcelain` (o parser é do módulo git). */
export interface WorktreeListada {
  repositorio: string;
  caminho: string;
  branch: string | null;
  prunable: boolean;
}

export interface ExecucaoAtivaComWorktree {
  execucao_id: string;
  caminho_worktree: string;
}

export interface ItemMergeIntegrando {
  item_id: string;
  execucao_id: string;
  sha_merge: string | null;
  repositorio: string;
  /** Ref que recebe o merge; no `merge_e_push`, a remota depois do `fetch`. */
  ref_destino: string;
  /** Worktree destacada `_integracao/<item8>` do item, se houver. */
  caminho_worktree: string | null;
}

export interface PassoOutboxEnviando {
  outbox_id: string;
  execucao_id: string;
  passo: PassoOutbox;
}

type Talvez<T> = T | Promise<T>;

export interface FontesReconciliacao {
  /** `etapa` em `executando` (com ou sem pid gravado). */
  etapasExecutando(): Talvez<EtapaComProcesso[]>;
  /** `sessao_terminal` com `encerrada_em IS NULL`. */
  sessoesTerminalAbertas(): Talvez<SessaoTerminalAberta[]>;
  /** Execuções não terminais que têm worktree gravada. */
  execucoesAtivas(): Talvez<ExecucaoAtivaComWorktree[]>;
  /** Worktrees de todos os repositórios dos projetos. */
  worktrees(): Talvez<WorktreeListada[]>;
  itensMergeIntegrando(): Talvez<ItemMergeIntegrando[]>;
  outboxEnviando(): Talvez<PassoOutboxEnviando[]>;
}

export interface SondasReconciliacao {
  sondar(processo: ProcessoParaSondar): EstadoSondado;
  /** `git merge-base --is-ancestor <sha> <ref>` (a sonda faz o `fetch` antes, se for o caso). */
  ehAncestral(repositorio: string, sha: string, ref: string): Promise<boolean>;
}

export interface OpcoesReconciliacao {
  /** `<dados>/worktrees`: só worktrees dentro dela são da Forja (o checkout do usuário não). */
  raizWorktrees: string;
}

export type RecuperacaoExecucao = 'retomar_agente' | 'refazer_verificacao' | 'reconciliar_merge';

export type AcaoReconciliacao =
  | {
      tipo: 'encerrar_grupo';
      pid: number;
      pgid: number;
      origem: 'etapa' | 'terminal';
      ref_id: string;
      estado_sondado: 'vivo' | 'grupo_orfao';
      /** `padrao` = SIGINT→SIGTERM→SIGKILL; `pty` = SIGHUP→SIGTERM→SIGKILL. */
      escada: 'padrao' | 'pty';
    }
  | {
      /** Varrer a worktree da execução (o orquestrador resolve o caminho e protege os PTYs). */
      tipo: 'varrer_cwd';
      etapa_id: string;
      execucao_id: string;
      tipo_etapa: TipoEtapa;
    }
  | {
      tipo: 'etapa_interrompida';
      etapa_id: string;
      execucao_id: string;
      tipo_etapa: TipoEtapa;
      processo: EstadoSondado | 'sem_pid';
      session_id: string | null;
    }
  | {
      tipo: 'execucao_interrompida';
      execucao_id: string;
      etapas: string[];
      recuperacao: RecuperacaoExecucao;
    }
  | {
      tipo: 'sessao_terminal_encerrada';
      sessao_terminal_id: string;
      assumida: boolean;
      execucao_id: string | null;
      processo: EstadoSondado | 'sem_pid';
    }
  | { tipo: 'worktree_orfa'; repositorio: string; caminho: string; branch: string | null }
  | { tipo: 'worktree_ausente'; execucao_id: string; caminho: string }
  | { tipo: 'podar_worktrees'; repositorio: string }
  | { tipo: 'item_merge_mergeado'; item_id: string; execucao_id: string; sha_merge: string }
  | { tipo: 'item_merge_recomecar'; item_id: string; execucao_id: string }
  | { tipo: 'item_merge_indeterminado'; item_id: string; execucao_id: string; erro: string }
  | { tipo: 'outbox_checar_ja_feito'; outbox_id: string; execucao_id: string; passo: PassoOutbox };

/** argv[0] esperado por tipo de etapa: agentes são `claude`; verificação/evidência, `sh`. */
export function comandoEsperadoDaEtapa(tipo: TipoEtapa): string {
  if (tipo === 'integrar') return 'git';
  if (ETAPAS_DO_APP.includes(tipo)) return 'sh';
  return 'claude';
}

function recuperacaoDe(tipos: readonly TipoEtapa[]): RecuperacaoExecucao {
  if (tipos.includes('integrar')) return 'reconciliar_merge';
  if (tipos.every((t) => t === 'verificar' || t === 'evidenciar')) return 'refazer_verificacao';
  return 'retomar_agente';
}

function sondarOuSemPid(
  pid: number | null,
  pgid: number | null,
  comando: string,
  sondas: SondasReconciliacao,
): EstadoSondado | 'sem_pid' {
  if (pid === null || pid <= 1) return 'sem_pid';
  return sondas.sondar({ pid, pgid: pgid ?? pid, comando });
}

const ehNosso = (e: EstadoSondado | 'sem_pid'): e is 'vivo' | 'grupo_orfao' =>
  e === 'vivo' || e === 'grupo_orfao';

export async function reconciliarNoBoot(
  fontes: FontesReconciliacao,
  sondas: SondasReconciliacao,
  opcoes: OpcoesReconciliacao,
): Promise<AcaoReconciliacao[]> {
  const matar: AcaoReconciliacao[] = [];
  const varrer: AcaoReconciliacao[] = [];
  const marcar: AcaoReconciliacao[] = [];
  const terminal: AcaoReconciliacao[] = [];
  const worktrees: AcaoReconciliacao[] = [];
  const merge: AcaoReconciliacao[] = [];
  const outbox: AcaoReconciliacao[] = [];

  // 1–2. Etapas com processo registrado.
  const porExecucao = new Map<string, { etapas: string[]; tipos: TipoEtapa[] }>();
  for (const etapa of await fontes.etapasExecutando()) {
    const comando = etapa.comando ?? comandoEsperadoDaEtapa(etapa.tipo);
    const estado = sondarOuSemPid(etapa.pid, etapa.pgid, comando, sondas);
    if (ehNosso(estado)) {
      matar.push({
        tipo: 'encerrar_grupo',
        pid: etapa.pid!,
        pgid: etapa.pgid ?? etapa.pid!,
        origem: 'etapa',
        ref_id: etapa.etapa_id,
        estado_sondado: estado,
        escada: 'padrao',
      });
    }
    if (etapa.tipo !== 'integrar') {
      varrer.push({
        tipo: 'varrer_cwd',
        etapa_id: etapa.etapa_id,
        execucao_id: etapa.execucao_id,
        tipo_etapa: etapa.tipo,
      });
    }
    marcar.push({
      tipo: 'etapa_interrompida',
      etapa_id: etapa.etapa_id,
      execucao_id: etapa.execucao_id,
      tipo_etapa: etapa.tipo,
      processo: estado,
      session_id: etapa.session_id,
    });
    const grupo = porExecucao.get(etapa.execucao_id) ?? { etapas: [], tipos: [] };
    grupo.etapas.push(etapa.etapa_id);
    grupo.tipos.push(etapa.tipo);
    porExecucao.set(etapa.execucao_id, grupo);
  }
  for (const [execucao_id, grupo] of porExecucao) {
    marcar.push({
      tipo: 'execucao_interrompida',
      execucao_id,
      etapas: grupo.etapas,
      recuperacao: recuperacaoDe(grupo.tipos),
    });
  }

  // 3. PTYs órfãos.
  for (const sessao of await fontes.sessoesTerminalAbertas()) {
    const estado = sondarOuSemPid(sessao.pid, sessao.pgid, 'claude', sondas);
    if (ehNosso(estado)) {
      matar.push({
        tipo: 'encerrar_grupo',
        pid: sessao.pid!,
        pgid: sessao.pgid ?? sessao.pid!,
        origem: 'terminal',
        ref_id: sessao.sessao_terminal_id,
        estado_sondado: estado,
        escada: 'pty',
      });
    }
    terminal.push({
      tipo: 'sessao_terminal_encerrada',
      sessao_terminal_id: sessao.sessao_terminal_id,
      assumida: sessao.tipo === 'assumida',
      execucao_id: sessao.execucao_id,
      processo: estado,
    });
  }

  // 4. Worktrees × execuções ativas.
  const listadas = (await fontes.worktrees()).filter((w) =>
    dentroDe(w.caminho, opcoes.raizWorktrees),
  );
  const ativas = await fontes.execucoesAtivas();
  const itens = await fontes.itensMergeIntegrando();
  const caminhosComDono = new Set<string>([
    ...ativas.map((e) => e.caminho_worktree),
    ...itens.flatMap((i) => (i.caminho_worktree ? [i.caminho_worktree] : [])),
  ]);
  const caminhosListados = new Set<string>();
  const podar = new Set<string>();
  for (const w of listadas) {
    if (w.prunable) {
      podar.add(w.repositorio);
      continue;
    }
    caminhosListados.add(w.caminho);
    if (!caminhosComDono.has(w.caminho)) {
      worktrees.push({
        tipo: 'worktree_orfa',
        repositorio: w.repositorio,
        caminho: w.caminho,
        branch: w.branch,
      });
    }
  }
  for (const e of ativas) {
    if (!caminhosListados.has(e.caminho_worktree)) {
      worktrees.push({
        tipo: 'worktree_ausente',
        execucao_id: e.execucao_id,
        caminho: e.caminho_worktree,
      });
    }
  }
  for (const repositorio of podar) worktrees.push({ tipo: 'podar_worktrees', repositorio });

  // 5. Fila de merge (03 §9.5).
  for (const item of itens) {
    if (!item.sha_merge) {
      merge.push({
        tipo: 'item_merge_recomecar',
        item_id: item.item_id,
        execucao_id: item.execucao_id,
      });
      continue;
    }
    try {
      const jaEntrou = await sondas.ehAncestral(item.repositorio, item.sha_merge, item.ref_destino);
      merge.push(
        jaEntrou
          ? {
              tipo: 'item_merge_mergeado',
              item_id: item.item_id,
              execucao_id: item.execucao_id,
              sha_merge: item.sha_merge,
            }
          : { tipo: 'item_merge_recomecar', item_id: item.item_id, execucao_id: item.execucao_id },
      );
    } catch (erro) {
      // Sem certeza não se re-mergeia nem se marca mergeado: humano decide.
      merge.push({
        tipo: 'item_merge_indeterminado',
        item_id: item.item_id,
        execucao_id: item.execucao_id,
        erro: (erro as Error).message,
      });
    }
  }

  // 6. Outbox (03 §9.2).
  for (const passo of await fontes.outboxEnviando()) {
    outbox.push({
      tipo: 'outbox_checar_ja_feito',
      outbox_id: passo.outbox_id,
      execucao_id: passo.execucao_id,
      passo: passo.passo,
    });
  }

  return [...matar, ...varrer, ...marcar, ...terminal, ...worktrees, ...merge, ...outbox];
}
