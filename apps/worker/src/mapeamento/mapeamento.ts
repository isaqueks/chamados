import type { DataSource } from 'typeorm';
import {
  GatilhoIA,
  type AIProvider,
  type AIMapeamentoInput,
  type ConhecimentoSistema,
  type MetadadosSistemaAlvo,
} from '@chamados/shared';
import {
  runInTenantContext,
  criarExecucao,
  marcarExecutando,
  concluirExecucaoMapeamento,
  falharExecucao,
  existeMapeamentoParaCommit,
  enfileirarMapeamento,
  salvarConhecimentoSistema,
  SistemaAlvoSchema,
  type SistemaAlvo,
} from '@chamados/db';
import { criarHandlesRepo, commitAtual } from '../triagem/ferramentas/repo';
import { motivoErro, telemetriaDoErro } from '../ia/erros';

/**
 * MAPA DE CONHECIMENTO por sistema-alvo (D-013). Uma execução de IA DEDICADA
 * (gatilho `mapeamento`, vinculada ao SISTEMA — sem chamado) explora o repositório
 * e produz um resumo estruturado (markdown), persistido em `sistema_alvo` com o
 * commit mapeado. É gerado na primeira triagem quando ausente, re-gerado quando o
 * commit do checkout muda, e sob demanda pelo admin ("Mapear agora"). O resumo é
 * injetado em toda triagem. Mesmo pipeline de guardrails/telemetria da triagem.
 *
 * Política POR COMMIT (D-033): o mapa é função do commit, não do chamado. Uma
 * tentativa automática por commit — falhou, não repete a cada triagem (em
 * produção, 20 mapeamentos falhos seguidos custaram ~3 min e uma execução de
 * Opus 5 por triagem, em silêncio). Só a primeira geração (sem mapa nenhum) roda
 * INLINE na triagem; a re-geração por commit divergente é ENFILEIRADA (fila
 * `mapeamento-ia`) e a triagem segue na hora com o mapa anterior.
 */

export interface MapaLimites {
  timeoutMs: number;
  budgetUsd: number;
  maxTurnos: number;
  maxChars: number;
}

export interface DepsMapeamento {
  ds: DataSource;
  tenantId: string;
  sistemaAlvoId: string;
  /** Diretório do checkout JÁ sincronizado (o chamador faz o git clone/pull). */
  checkoutDir: string;
  provider: AIProvider;
  limites: MapaLimites;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Deriva um resumo de stack (SEM credenciais) a partir dos tipos configurados. */
function stackDe(bdTipo: string | null, logsTipo: string | null): string | null {
  const partes: string[] = [];
  if (bdTipo) partes.push(`bd: ${bdTipo}`);
  if (logsTipo) partes.push(`logs: ${logsTipo}`);
  return partes.length > 0 ? partes.join(' · ') : null;
}

function metadadosDe(s: SistemaAlvo): MetadadosSistemaAlvo {
  return { nome: s.nome, descricao: s.descricao, stack: stackDe(s.bd_tipo, s.logs_tipo) };
}

/**
 * Executa o mapeamento como uma `ExecucaoIA` dedicada (na_fila → executando →
 * concluido/falhou), persistindo resumo + commit + timestamp no sistema-alvo.
 * Lança em caso de falha (a execução fica `falhou` com o motivo). Devolve o
 * `ConhecimentoSistema` recém-gerado.
 */
export async function executarMapeamento(deps: DepsMapeamento): Promise<ConhecimentoSistema> {
  const { ds, tenantId, sistemaAlvoId, checkoutDir, provider, limites, log } = deps;

  // Trilha de ações (chamadas de ferramenta) — auditada em ExecucaoIA.acoes.
  const acoes: unknown[] = [];
  const registrar = (ferramenta: string, args: unknown): void => {
    acoes.push({ ferramenta, args, em: new Date().toISOString() });
  };
  const repo = criarHandlesRepo(() => checkoutDir, registrar);
  const ferramentas: AIMapeamentoInput['ferramentas'] = {
    repo_buscar: repo.repo_buscar,
    repo_ler_arquivo: repo.repo_ler_arquivo,
    repo_arvore: repo.repo_arvore,
  };

  const commit = await commitAtual(checkoutDir);

  // Carrega metadados + abre a ExecucaoIA (vinculada ao SISTEMA, sem chamado).
  const prep = await runInTenantContext(ds, tenantId, async (em) => {
    const s = await em.findOne(SistemaAlvoSchema, { where: { id: sistemaAlvoId } });
    if (!s) throw new Error('sistema_alvo_inexistente');
    const execucaoId = await criarExecucao(
      em,
      { tenant_id: tenantId },
      {
        sistema_alvo_id: sistemaAlvoId,
        gatilho: GatilhoIA.mapeamento,
        provider: provider.nome,
        modelo: provider.modelo,
        entrada: { gatilho: GatilhoIA.mapeamento, sistema_alvo_id: sistemaAlvoId, commit },
      },
    );
    await marcarExecutando(em, execucaoId);
    return { execucaoId, meta: metadadosDe(s) };
  });

  log('mapeamento iniciado', { sistemaAlvoId, execucaoId: prep.execucaoId, commit });

  try {
    const resultado = await provider.mapearSistema({
      sistemaAlvo: prep.meta,
      ferramentas,
      limites: {
        timeoutMs: limites.timeoutMs,
        budgetUsd: limites.budgetUsd,
        maxTurnos: limites.maxTurnos,
      },
      maxChars: limites.maxChars,
      // D-014: exploração NATIVA (Read/Grep/Glob) escopada ao checkout já
      // sincronizado; a `auditar` alimenta a mesma trilha `acoes`.
      exploracao: { checkoutDir, auditar: registrar },
    });

    const geradoEm = new Date();
    await runInTenantContext(ds, tenantId, async (em) => {
      await salvarConhecimentoSistema(em, sistemaAlvoId, {
        resumo: resultado.resumo,
        commit,
        geradoEm,
      });
      await concluirExecucaoMapeamento(em, prep.execucaoId, resultado, acoes);
    });

    log('mapeamento concluído', {
      sistemaAlvoId,
      execucaoId: prep.execucaoId,
      chars: resultado.resumo.length,
      acoes: acoes.length,
    });
    return { resumo: resultado.resumo, commit, geradoEm: geradoEm.toISOString() };
  } catch (err) {
    const erro = motivoErro(err);
    // D-033: telemetria PARCIAL (tokens/custo até o corte) — antes o custo das
    // falhas por limite sumia do registro.
    await runInTenantContext(ds, tenantId, (em) =>
      falharExecucao(em, prep.execucaoId, erro, {
        acoes,
        telemetriaParcial: telemetriaDoErro(err),
      }),
    ).catch(() => {});
    log('mapeamento falhou', { sistemaAlvoId, execucaoId: prep.execucaoId, erro });
    throw err;
  }
}

/**
 * Garante o conhecimento para a triagem (D-013, política por commit de D-033).
 * Compara o commit armazenado com o HEAD do checkout:
 *
 * - **atualizado** (há resumo e o commit bate) → devolve o armazenado;
 * - **commit já tentado** (existe ExecucaoIA de mapeamento para este commit, em
 *   qualquer status) → NÃO dispara outra automaticamente; devolve o armazenado
 *   (ou `null`). Quem quiser insistir usa "Mapear agora";
 * - **sem mapa nenhum** → primeira geração INLINE (a triagem espera e já usa o
 *   mapa novo — specs/05 §3.3 gatilho 1);
 * - **mapa defasado** (commit divergente) → ENFILEIRA a re-geração e devolve o
 *   armazenado na hora (specs/05 §3.3 gatilho 2) — a triagem não paga os minutos
 *   do mapeamento.
 *
 * Best-effort em todos os ramos: falha de mapa nunca derruba a triagem.
 */
export async function garantirConhecimento(
  deps: DepsMapeamento,
): Promise<ConhecimentoSistema | null> {
  const { ds, tenantId, sistemaAlvoId, checkoutDir, log } = deps;

  const [armazenado, commit] = await Promise.all([
    runInTenantContext(ds, tenantId, (em) =>
      em.findOne(SistemaAlvoSchema, { where: { id: sistemaAlvoId } }),
    ),
    commitAtual(checkoutDir),
  ]);

  const conhecimentoArmazenado: ConhecimentoSistema | null =
    armazenado?.conhecimento_resumo && armazenado.conhecimento_gerado_em
      ? {
          resumo: armazenado.conhecimento_resumo,
          commit: armazenado.conhecimento_commit,
          geradoEm: armazenado.conhecimento_gerado_em.toISOString(),
        }
      : null;

  // Atualizado quando há resumo E o commit bate com o HEAD atual (commit != null).
  const atualizado =
    conhecimentoArmazenado !== null && commit !== null && conhecimentoArmazenado.commit === commit;
  if (atualizado) {
    log('conhecimento atualizado (sem remapear)', { sistemaAlvoId, commit });
    return conhecimentoArmazenado;
  }

  // Uma tentativa automática por commit (D-033). Sem commit (checkout sem git)
  // não há como deduplicar: só mapeia se não existe mapa nenhum.
  if (commit !== null) {
    const jaTentado = await runInTenantContext(ds, tenantId, (em) =>
      existeMapeamentoParaCommit(em, sistemaAlvoId, commit),
    ).catch(() => false);
    if (jaTentado) {
      log('conhecimento: mapeamento deste commit já foi tentado — sem nova tentativa automática', {
        sistemaAlvoId,
        commit,
        temMapaAnterior: conhecimentoArmazenado !== null,
      });
      return conhecimentoArmazenado;
    }
  } else if (conhecimentoArmazenado !== null) {
    log('conhecimento: checkout sem commit identificável — segue com o mapa armazenado', {
      sistemaAlvoId,
    });
    return conhecimentoArmazenado;
  }

  if (conhecimentoArmazenado === null) {
    // Primeira geração: inline — esta triagem já se beneficia do mapa.
    try {
      return await executarMapeamento(deps);
    } catch {
      log('conhecimento: primeiro mapeamento falhou; segue triagem sem mapa', { sistemaAlvoId });
      return null;
    }
  }

  // Mapa defasado: re-geração ASSÍNCRONA; a triagem segue com o anterior.
  try {
    await enfileirarMapeamento({ tenantId, sistemaAlvoId });
    log(
      'conhecimento: commit divergente — re-mapeamento enfileirado; triagem segue com o mapa anterior',
      {
        sistemaAlvoId,
        commit,
        commitMapeado: conhecimentoArmazenado.commit,
      },
    );
  } catch (err) {
    log('conhecimento: falha ao enfileirar re-mapeamento; triagem segue com o mapa anterior', {
      sistemaAlvoId,
      erro: motivoErro(err),
    });
  }
  return conhecimentoArmazenado;
}
