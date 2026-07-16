import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  runInTenantContext,
  listarTenantsAtivos,
  fecharChamadosResolvidosVencidos,
  marcarExecucoesOrfas,
  listarChamadosEncalhadosEmTriagem,
  DespachanteNotificacoes,
} from '@chamados/db';
import { escalarParaHumano } from '../triagem/aplicador';

/**
 * Processador do job `manutencao` (M10 — specs/04 §8.1 + D-016): varreduras
 * periódicas de ciclo de vida, por TODOS os tenants ativos:
 *
 *  1. AUTO-FECHAMENTO de chamados `resolvido` vencidos (M10).
 *  2. EXECUÇÕES ÓRFÃS (D-016): `ExecucaoIA` presa em `na_fila`/`executando` além
 *     do limiar (worker morto no meio — kill/crash) vira `falhou` (`execucao_orfa`)
 *     e o chamado associado é ESCALADO a um humano.
 *  3. TRIAGEM ENCALHADA (D-016): chamado parado em `em_triagem` sem execução
 *     ativa E sem job pendente na fila (job perdido/compensação falha) é
 *     escalado a um humano — a rede de segurança FINAL da promessa "o chamado
 *     nunca fica preso sem responsável" (specs/05 §8).
 *
 * Fluxo por execução:
 *  1. LOCK global (Redis SET NX PX) — se outra instância já roda a varredura, sai
 *     sem duplicar trabalho (idempotência entre instâncias concorrentes).
 *  2. Enumera os tenants ativos via a função SECURITY DEFINER (fora de contexto
 *     RLS — o role da app não lista a tabela `tenant`).
 *  3. Para cada tenant: `runInTenantContext` + as varreduras acima, com um
 *     `DespachanteNotificacoes` injetado no auto-fechamento (o cliente é
 *     notificado). As notificações são enfileiradas PÓS-COMMIT (`flush`).
 *
 * As varreduras são idempotentes; o lock evita apenas o desperdício de duas
 * instâncias varrerem ao mesmo tempo.
 */

/** Chave do lock global da varredura (exportada para o smoke testar concorrência). */
export const CHAVE_LOCK_MANUTENCAO = 'chamados:lock:manutencao';
const CHAVE_LOCK = CHAVE_LOCK_MANUTENCAO;

/** Lua: só deleta o lock se o token bater (release seguro do próprio dono). */
const SCRIPT_LIBERAR = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export interface DepsManutencao {
  ds: DataSource;
  redis: Redis;
  /** TTL do lock global da varredura (deve exceder a duração esperada). */
  lockTtlMs: number;
  /** Limiar para `ExecucaoIA` órfã (`na_fila`/`executando` sem progresso). */
  execucaoOrfaMs: number;
  /** Limiar para chamado encalhado em `em_triagem` sem execução ativa. */
  triagemEncalhadaMs: number;
  /**
   * Chamados com job de triagem pendente/ativo na fila (para NÃO escalar quem
   * ainda vai rodar — ex.: debounce ou reagendamento por lock). Injetado pelo
   * registrador da fila; ausente (testes/smokes) → conjunto vazio.
   */
  chamadosComTriagemPendente?: () => Promise<Set<string>>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ResultadoManutencao {
  /** `false` quando o lock estava ocupado (outra instância varrendo). */
  executou: boolean;
  tenants: number;
  fechados: number;
  /** Execuções de IA órfãs marcadas como `falhou` (D-016). */
  execucoesOrfas: number;
  /** Chamados encalhados em `em_triagem` escalados a humano (D-016). */
  encalhados: number;
}

/**
 * Executa uma varredura de manutenção. Retorna o resumo (para logs/smoke).
 * Best-effort por tenant: uma falha em um tenant é registrada e não interrompe
 * os demais.
 */
export async function executarManutencao(deps: DepsManutencao): Promise<ResultadoManutencao> {
  const token = randomUUID();
  const adquiriu = await deps.redis.set(CHAVE_LOCK, token, 'PX', deps.lockTtlMs, 'NX');
  if (adquiriu !== 'OK') {
    deps.log('manutencao: lock ocupado — outra instância está varrendo, pulando');
    return { executou: false, tenants: 0, fechados: 0, execucoesOrfas: 0, encalhados: 0 };
  }

  try {
    const tenants = await listarTenantsAtivos(deps.ds);
    // Uma consulta à fila por varredura (não por tenant) — jobs pendentes de
    // triagem de QUALQUER tenant, indexados por chamadoId (prefixo do jobId).
    let pendentes = new Set<string>();
    if (deps.chamadosComTriagemPendente) {
      try {
        pendentes = await deps.chamadosComTriagemPendente();
      } catch (err) {
        // Sem a lista, escalar seria FALSO-POSITIVO (job pendente legítimo):
        // pula a varredura de encalhados nesta rodada.
        deps.log('manutencao: fila de triagem inacessível — varredura de encalhados adiada', {
          erro: (err as Error).message,
        });
        pendentes = new Set(['*indisponivel*']);
      }
    }
    const filaIndisponivel = pendentes.has('*indisponivel*');

    let fechados = 0;
    let execucoesOrfas = 0;
    let encalhados = 0;
    for (const tenantId of tenants) {
      try {
        // 1) Auto-fechamento de `resolvido` vencidos (M10).
        const despachante = new DespachanteNotificacoes(deps.log);
        const res = await runInTenantContext(deps.ds, tenantId, (em) =>
          fecharChamadosResolvidosVencidos(em, tenantId, { despachante }),
        );
        // Enfileira as notificações de fechamento PÓS-COMMIT (best-effort).
        await despachante.flush();
        if (res.fechados.length > 0) {
          fechados += res.fechados.length;
          deps.log('manutencao: chamados auto-fechados', {
            tenantId,
            quantidade: res.fechados.length,
          });
        }

        // 2) Execuções de IA órfãs → `falhou` + escalonamento (D-016).
        const orfas = await runInTenantContext(deps.ds, tenantId, async (em) => {
          const marcadas = await marcarExecucoesOrfas(em, deps.execucaoOrfaMs);
          for (const o of marcadas) {
            if (o.chamado_id) {
              await escalarParaHumano(
                em,
                {
                  tenantId,
                  chamadoId: o.chamado_id,
                  execucaoId: o.id,
                  erro: 'execucao_orfa',
                },
                { log: deps.log },
              );
            }
          }
          return marcadas.length;
        });
        if (orfas > 0) {
          execucoesOrfas += orfas;
          deps.log('manutencao: execuções de IA órfãs marcadas como falha', {
            tenantId,
            quantidade: orfas,
          });
        }

        // 3) Chamados encalhados em `em_triagem` → escalonamento (D-016).
        if (!filaIndisponivel) {
          const escalados = await runInTenantContext(deps.ds, tenantId, async (em) => {
            const ids = await listarChamadosEncalhadosEmTriagem(em, deps.triagemEncalhadaMs);
            let n = 0;
            for (const chamadoId of ids) {
              if (pendentes.has(chamadoId)) continue; // ainda vai rodar — não escala
              await escalarParaHumano(
                em,
                { tenantId, chamadoId, execucaoId: null, erro: 'triagem_nao_executada' },
                { log: deps.log },
              );
              n += 1;
            }
            return n;
          });
          if (escalados > 0) {
            encalhados += escalados;
            deps.log('manutencao: chamados encalhados em em_triagem escalados', {
              tenantId,
              quantidade: escalados,
            });
          }
        }
      } catch (err) {
        deps.log('manutencao: falha ao varrer tenant (ignorado)', {
          tenantId,
          erro: (err as Error).message,
        });
      }
    }
    return { executou: true, tenants: tenants.length, fechados, execucoesOrfas, encalhados };
  } finally {
    await deps.redis.eval(SCRIPT_LIBERAR, 1, CHAVE_LOCK, token).catch(() => {
      /* release best-effort: o TTL cobre o lock se o del falhar */
    });
  }
}
