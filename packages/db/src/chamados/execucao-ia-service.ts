import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  autorizar,
  StatusExecucaoIA,
  type AIProviderResult,
  type AIMapeamentoResult,
} from '@chamados/shared';
import { ExecucaoIASchema, type ExecucaoIA } from '../entities/execucao-ia';
import { ChamadoSchema } from '../entities/chamado';
import type { AtorChamado } from './chamado-service';

/**
 * Serviços de `ExecucaoIA` (specs/02, specs/05). Rodam SEMPRE dentro de
 * `runInTenantContext` (transação + RLS). Ciclo de vida:
 *   criar (na_fila) → marcarExecutando (executando) → concluir (concluido)
 *                                                    └→ falhar (falhou)
 * `timeout`/`budget_excedido` são MOTIVOS (campo `erro`) sobre `status = falhou`,
 * não status próprios (specs/05 §8). A telemetria (`custoUsd`/`duracaoMs`/
 * `tokensEntrada`/`tokensSaida`) é gravada com EXATAMENTE esses nomes de origem
 * (specs/01 §4.1) nas colunas `custo_usd`/`duracao_ms`/`tokens_entrada`/`tokens_saida`.
 */

export interface EntradaCriarExecucao {
  /** Chamado (triagem/resolução). Exatamente um de chamado_id/sistema_alvo_id (CHECK XOR). */
  chamado_id?: string | null;
  /** Sistema-alvo (mapeamento — D-013). Exatamente um de chamado_id/sistema_alvo_id. */
  sistema_alvo_id?: string | null;
  gatilho: string;
  provider: string;
  modelo: string;
  /** Snapshot sanitizado do input (deve conter `ultima_mensagem_id` na triagem). */
  entrada: Record<string, unknown>;
}

/** Cria a execução em `na_fila`. Retorna o id gerado. */
export async function criarExecucao(
  em: EntityManager,
  ator: { tenant_id: string },
  dados: EntradaCriarExecucao,
): Promise<string> {
  const res = await em.insert(ExecucaoIASchema, {
    tenant_id: ator.tenant_id,
    chamado_id: dados.chamado_id ?? null,
    sistema_alvo_id: dados.sistema_alvo_id ?? null,
    status: StatusExecucaoIA.na_fila,
    provider: dados.provider,
    modelo: dados.modelo,
    gatilho: dados.gatilho,
    entrada: dados.entrada,
    acoes: [],
  });
  return res.identifiers[0]!.id as string;
}

/** Transiciona para `executando` e marca `iniciado_em`. */
export async function marcarExecutando(em: EntityManager, id: string): Promise<void> {
  await em.update(
    ExecucaoIASchema,
    { id },
    { status: StatusExecucaoIA.executando, iniciado_em: new Date() },
  );
}

/**
 * Conclui a execução (`concluido`) gravando o resultado BRUTO do provider e a
 * telemetria. `acoes` é a trilha coletada durante a execução (ex.: chamadas de
 * ferramenta stub no M6).
 */
export async function concluirExecucao(
  em: EntityManager,
  id: string,
  resultado: AIProviderResult,
  acoes: unknown[] = [],
): Promise<void> {
  const t = resultado.telemetria;
  await em.update(
    ExecucaoIASchema,
    { id },
    {
      status: StatusExecucaoIA.concluido,
      resultado,
      acoes,
      custo_usd: String(t.custoUsd),
      duracao_ms: Math.round(t.duracaoMs),
      tokens_entrada: Math.round(t.tokensEntrada),
      tokens_saida: Math.round(t.tokensSaida),
      finalizado_em: new Date(),
    },
  );
}

/**
 * Conclui uma execução de MAPEAMENTO (D-013), gravando o resumo (`resultado`) e a
 * telemetria. Análogo a `concluirExecucao`, mas o `resultado` é um
 * `AIMapeamentoResult` (não há classificação de chamado).
 */
export async function concluirExecucaoMapeamento(
  em: EntityManager,
  id: string,
  resultado: AIMapeamentoResult,
  acoes: unknown[] = [],
): Promise<void> {
  const t = resultado.telemetria;
  await em.update(
    ExecucaoIASchema,
    { id },
    {
      status: StatusExecucaoIA.concluido,
      resultado,
      acoes,
      custo_usd: String(t.custoUsd),
      duracao_ms: Math.round(t.duracaoMs),
      tokens_entrada: Math.round(t.tokensEntrada),
      tokens_saida: Math.round(t.tokensSaida),
      finalizado_em: new Date(),
    },
  );
}

/**
 * Falha a execução (`falhou`) com o `erro` detalhado (specs/05 §8: 'timeout',
 * 'budget_excedido' ou mensagem do provider). Persiste telemetria parcial se houver.
 */
export async function falharExecucao(
  em: EntityManager,
  id: string,
  erro: string,
  opts: { acoes?: unknown[]; telemetriaParcial?: Partial<AIProviderResult['telemetria']> } = {},
): Promise<void> {
  const t = opts.telemetriaParcial ?? {};
  await em.update(
    ExecucaoIASchema,
    { id },
    {
      status: StatusExecucaoIA.falhou,
      erro,
      acoes: opts.acoes ?? [],
      custo_usd: t.custoUsd !== undefined ? String(t.custoUsd) : null,
      duracao_ms: t.duracaoMs !== undefined ? Math.round(t.duracaoMs) : null,
      tokens_entrada: t.tokensEntrada !== undefined ? Math.round(t.tokensEntrada) : null,
      tokens_saida: t.tokensSaida !== undefined ? Math.round(t.tokensSaida) : null,
      finalizado_em: new Date(),
    },
  );
}

/**
 * Idempotência (specs/05 §2): já existe uma execução CONCLUÍDA para o par
 * (chamado, última mensagem)? O `ultima_mensagem_id` vive no snapshot `entrada`.
 */
export async function existeConcluidaParaMensagem(
  em: EntityManager,
  chamadoId: string,
  ultimaMensagemId: string | null,
): Promise<boolean> {
  const chave = ultimaMensagemId ?? 'inicial';
  const linhas: Array<{ existe: boolean }> = await em.query(
    `SELECT EXISTS (
       SELECT 1 FROM execucao_ia
        WHERE chamado_id = $1
          AND status = $2
          AND COALESCE(entrada->>'ultima_mensagem_id', 'inicial') = $3
     ) AS existe`,
    [chamadoId, StatusExecucaoIA.concluido, chave],
  );
  return linhas[0]?.existe === true;
}

// ---------------------------------------------------------------------------
// Leitura (painel operador/admin — specs/08 §4.3)
// ---------------------------------------------------------------------------

/** Projeção de `ExecucaoIA` para o painel (nunca exposta ao cliente). */
export interface ExecucaoIAView {
  id: string;
  status: StatusExecucaoIA;
  gatilho: string;
  provider: string;
  modelo: string;
  custo_usd: string | null;
  tokens_entrada: number | null;
  tokens_saida: number | null;
  duracao_ms: number | null;
  erro: string | null;
  resultado: AIProviderResult | null;
  iniciado_em: Date | null;
  finalizado_em: Date | null;
  created_at: Date;
}

function toView(e: ExecucaoIA): ExecucaoIAView {
  return {
    id: e.id,
    status: e.status,
    gatilho: e.gatilho,
    provider: e.provider,
    modelo: e.modelo,
    custo_usd: e.custo_usd,
    tokens_entrada: e.tokens_entrada,
    tokens_saida: e.tokens_saida,
    duracao_ms: e.duracao_ms,
    erro: e.erro,
    resultado: (e.resultado as AIProviderResult | null) ?? null,
    iniciado_em: e.iniciado_em,
    finalizado_em: e.finalizado_em,
    created_at: e.created_at,
  };
}

/**
 * Lista as execuções de IA de um chamado (mais recentes primeiro). Só
 * operador/admin/agente_ia veem `ExecucaoIA` — o CLIENTE nunca (nem a
 * existência), por `autorizar(execucao_ia, ler)` (specs/03 §8, matriz). RLS é a
 * rede de segurança do isolamento por tenant.
 */
export async function listarExecucoesDoChamado(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
): Promise<ExecucaoIAView[]> {
  if (!autorizar(ator, 'execucao_ia', 'ler')) return [];

  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return [];

  const linhas = await em.find(ExecucaoIASchema, {
    where: { chamado_id: chamadoId },
    order: { created_at: 'DESC' },
  });
  return linhas.map(toView);
}

/**
 * Lista as execuções de MAPEAMENTO de um sistema-alvo (D-013 — mais recentes
 * primeiro). Mesma autorização de `listarExecucoesDoChamado` (`execucao_ia` `ler`:
 * operador/admin/agente_ia; o cliente nunca vê). Usa o índice
 * `(tenant_id, sistema_alvo_id, created_at)`.
 */
export async function listarExecucoesDoSistema(
  em: EntityManager,
  ator: AtorChamado,
  sistemaAlvoId: string,
  opts: { limite?: number } = {},
): Promise<ExecucaoIAView[]> {
  if (!autorizar(ator, 'execucao_ia', 'ler')) return [];
  const linhas = await em.find(ExecucaoIASchema, {
    where: { sistema_alvo_id: sistemaAlvoId },
    order: { created_at: 'DESC' },
    take: opts.limite ?? 10,
  });
  return linhas.map(toView);
}
