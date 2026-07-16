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
  salvarConhecimentoSistema,
  SistemaAlvoSchema,
  type SistemaAlvo,
} from '@chamados/db';
import { criarHandlesRepo, commitAtual } from '../triagem/ferramentas/repo';
import { motivoErro } from '../ia/erros';

/**
 * MAPA DE CONHECIMENTO por sistema-alvo (D-013). Uma execução de IA DEDICADA
 * (gatilho `mapeamento`, vinculada ao SISTEMA — sem chamado) explora o repositório
 * e produz um resumo estruturado (markdown), persistido em `sistema_alvo` com o
 * commit mapeado. É gerado na primeira triagem quando ausente, re-gerado quando o
 * commit do checkout muda, e sob demanda pelo admin ("Mapear agora"). O resumo é
 * injetado em toda triagem. Mesmo pipeline de guardrails/telemetria da triagem.
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
    await runInTenantContext(ds, tenantId, (em) =>
      falharExecucao(em, prep.execucaoId, erro, { acoes }),
    ).catch(() => {});
    log('mapeamento falhou', { sistemaAlvoId, execucaoId: prep.execucaoId, erro });
    throw err;
  }
}

/**
 * Garante o conhecimento ATUALIZADO antes da triagem (D-013). Compara o commit
 * armazenado com o HEAD do checkout: se o resumo está ausente OU o commit mudou,
 * roda o mapeamento (ExecucaoIA separada) e devolve o resumo fresco. Best-effort:
 * se o mapeamento falhar, devolve o resumo ARMAZENADO (possivelmente defasado) ou
 * `null` — a triagem prossegue mesmo assim (nunca fica presa por falha de mapa).
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

  try {
    return await executarMapeamento(deps);
  } catch {
    log('conhecimento: mapeamento falhou; segue triagem com o resumo armazenado (ou nenhum)', {
      sistemaAlvoId,
    });
    return conhecimentoArmazenado;
  }
}
